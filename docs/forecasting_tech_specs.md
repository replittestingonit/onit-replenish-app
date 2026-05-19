# Technical Specifications: Advanced Seasonal Forecasting Engine

This document outlines the technical implementation plan for upgrading the Shopify Protect forecasting engine to support Geographic/Seasonal Profiles, Grok AI generation, Categorical Proxy Demand, and Edge-Case Overrides (Promotions, EOL, Hero Items).

## 1. Database Schema Specifications (Prisma)

The following schema modifications are required to support the new data models.

### 1.1 `DemandProfile` (New Model)
Stores the normalized 12-month curves and ties them to a region and category.
```prisma
model DemandProfile {
  id              String   @id @default(cuid())
  shop            String
  name            String   // e.g., "Winter Gear - FL"
  category        String?
  region          String?
  
  // Normalized 12-month multipliers (Must sum to 1.0)
  weights         String   // JSON Array: [0.05, 0.05, 0.1, ...]
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  configs         ReorderConfig[]
  
  @@unique([shop, name])
}
```

### 1.2 `ReorderConfig` (Modifications)
Extends the existing model to support advanced algorithm toggles and proxy links.
```prisma
model ReorderConfig {
  // Existing fields...
  id              String   @id @default(cuid())
  shop            String
  inventoryItemId String   
  leadTimeDays    Int      @default(14)
  useManualMinimum Boolean @default(false)
  manualMinimum   Int?

  // NEW: Algorithm Tuning
  protectionLevel Int      @default(2) // 1=Lean, 2=Balanced(2σ), 3=High, 6=Hero Item
  lookbackDays    Int      @default(90) // 30, 90, 180, 365
  
  // NEW: Edge Case Overrides
  ignorePromotions Boolean @default(false) // Scrub 4σ+ spikes
  isEndOfLife      Boolean @default(false) // Forces ReorderPoint = 0
  
  // NEW: Cold Start & Seasonality
  demandProfileId String?
  demandProfile   DemandProfile? @relation(fields: [demandProfileId], references: [id])
  expectedAnnualVolume Int?
  
  // NEW: Proxy Demand (Cannibalization)
  productCategoryId String?
  productCategory   ProductCategory? @relation(fields: [productCategoryId], references: [id])
}

### 1.3 Removed: `ProductCategory` (Automated via Shopify Native Meta)
*To eliminate user friction, we do NOT require the user to manually create categories. The system automatically ingests the native Shopify `ProductType` field (e.g., "Sunscreen"). All proxy demand bundling happens automatically behind the scenes based on how the store owner already set up their Shopify catalog.*

### 1.4 `AppConfiguration` (Modifications)
Extends the global app configuration to support the overarching engine toggle.
```prisma
model AppConfiguration {
  // Existing fields...
  shop                  String   @id
  
  // NEW: Forecasting Engine Mode
  forecastingMode       String   @default("advanced") // "basic" | "advanced"
}
```

### 1.4 `ForecastAlert` (New Model)
Stores proactive AI prompts that surface on the main dashboard under the "Predict" filter.
```prisma
model ForecastAlert {
  id              String   @id @default(cuid())
  shop            String
  inventoryItemId String
  alertType       String   // "promo_spike", "dying_sku", "cold_start"
  message         String   // "Sales spiked 500%. Was this a flash sale?"
  status          String   @default("pending") // "pending", "resolved", "ignored"
  createdAt       DateTime @default(now())
  
  @@index([shop, status])
}
```
```

## 2. Backend Engine Implementation (`forecast.server.ts`)

The `runForecast` function will be refactored into a multi-stage pipeline.

### Phase 1: Data Ingestion & Scrubbing
1. Fetch `lookbackDays` (up to 365) of sales data via Shopify GraphQL.
2. **Promotional Scrubbing:** If `ignorePromotions == true`:
   - Calculate baseline mean and standard deviation for the dataset.
   - Filter out any daily data point where `sales > (mean + (4 * stdDev))`.
   - Recalculate the mean and standard deviation on the scrubbed dataset.

### Phase 2: Demand Calculation (Branching Logic)
First, the engine checks the global `AppConfiguration.forecastingMode`.

**Path 0: "Stupid" Basic Forecasting (If mode == "basic")**
- Bypasses all advanced logic.
- Calculates a simple trailing average.
- Safety Stock is hardcoded to `leadTime * 0.5`. 
- *(Exists purely to empower the owner to opt-out of complexity).*

**If mode == "advanced", proceed to Advanced Branching:**

**Path A: The EOL Override**
- If `isEndOfLife == true` -> Set Reorder Point = 0, Suggested Qty = 0. Exit early.

**Path B: Cold-Start Profile (New SKUs)**
- If `expectedAnnualVolume` exists and historical sales < 30 days:
  - Fetch `weights` JSON from the linked `DemandProfile`.
  - Calculate daily velocity for the *current* month based on the curve.
  - Apply blending algorithm: `(Profile_Velocity * (90 - daysActive) + Actual_Velocity * daysActive) / 90`.

**Path C: Categorical Proxy (Cannibalization)**
- If historical sales < 30 days:
  - The engine checks the SKU's native Shopify `ProductType` (e.g., "Sunscreen").
  - Aggregate total historical sales for ALL existing SKUs in the store with that same `ProductType`.
  - Divide by total active SKUs in that type.
  - Automatically assign this normalized proxy velocity to the new SKU. No user input required.

**Path D: Standard Statistical Engine (Existing)**
- Calculate `avgDailySales` based on chosen `lookbackDays`.

### Phase 3: Variance Application & Alert Generation
1. **Determine Sigma:** Map `protectionLevel` (1, 2, 3, or 6) to the standard deviation multiplier.
2. **Calculate Base Safety:** `SafetyStock = Sigma * StdDev * Math.sqrt(LeadTime)`.
3. **Apply Merchandising Floor:** 
   - `ReorderPoint = Math.max((avgDaily * LeadTime) + SafetyStock, manualMinimum)`.

4. **Proactive AI Alert Generation (The "Predict" Engine):**
   - *Spike Detection:* If today's sales > (Mean + 4σ), generate a `ForecastAlert` (Type: `promo_spike`).
   - *Death Detection:* If 90-day trend is steep decline and stock is high, generate `ForecastAlert` (Type: `dying_sku`).
   - *Cold Start Detection:* If a new SKU is detected with 0 history, generate `ForecastAlert` (Type: `cold_start`).

## 3. Grok AI Integration Specifications

The AI integration will reside in a new service file: `app/services/grok.server.ts`.

### Architecture
- **Provider:** xAI Grok API (using existing ONIT enterprise keys).
- **Endpoint:** POST `/api/grok/generate-profile`

### System Prompt Engineering
```json
{
  "role": "system",
  "content": "You are a quantitative retail supply chain analyst. The user will provide a product category and a geographic region. You must output exactly 12 floating point numbers representing the expected distribution of annual sales across January through December. The sum of the 12 numbers MUST exactly equal 1.0. Do not include markdown, text, or explanations. Only output a valid JSON array of 12 floats."
}
```

### Constraints & Error Handling
- **Validation:** The backend will parse the JSON response. If `length !== 12` or `sum(weights) !== 1.0`, it will return a 422 error and prompt the user to retry.
- **Caching:** Generated profiles are saved to the `DemandProfile` table. If a user requests "Winter Coats in FL" and it already exists in the DB for that shop, the database record is returned instantly (bypassing the LLM).

## 4. Frontend UI Implementation (`app.forecast.tsx` & `app._index.tsx`)

### The Dashboard "Predict" Filter (`app._index.tsx`)
The main dashboard will receive a new top-level filter alongside "Alerts" and "POs": **"Predict"**.
- This view lists pending `ForecastAlert` records.
- **Example Card:** "We noticed a 500% spike in SKU 123 over the weekend. Was this a flash sale?"
- **Action Buttons:** [Yes, Ignore Sales] / [No, Real Trend]. Clicking "Yes" automatically updates the SKU's `ignorePromotions` config, requiring zero math from the user.

### The Forecast Page (`app.forecast.tsx`)
The UI modifications require a Global Settings toggle and a tabbed modal interface.

**Global Engine Toggle:**
A prominent switch at the top of the Demand Forecast page:
- [ Basic Forecasting ] / [ **Advanced Enterprise Forecasting** ]
- Toggling this to "Basic" disables the AI features and reverts to dumb math, making the user feel empowered over the software's complexity.

**Product Detail Modal:**
*   **Tab 1: Basic Forecasting** (Current view - Lead time, floor, suggested POs).
*   **Tab 2: Advanced Tuning**
    *   Radio group for "Protection Level" (Lean, Balanced, Hero).
    *   Radio group for "Lookback Window".
    *   Toggles for "Ignore Promos" and "End of Life".
*   **Tab 3: Seasonal Provisioning**
    *   **Seasonal Curves:** Searchable Dropdown of `DemandProfiles`. "Generate New Curve via AI" button.
    *   **Automated Cannibalization (Read-Only):** The UI simply displays a reassurance badge based on Shopify metadata: 
    *   *UI Feedback:* "We see Shopify categorizes this as **'Sunscreen'**. We are automatically grouping this with your 4 other sunscreens to prevent over-ordering."

### Visualizations:
- Incorporate a Recharts `<BarChart>` component to visually display the 12-month curve when a `DemandProfile` is selected, proving to the user that the AI correctly understood the geographic seasonality.

## 5. Deployment Phases
*   **Phase 1:** Prisma schema migrations and basic backend CRUD for `DemandProfile`.
*   **Phase 2:** Implement Grok API integration and the UI for generating/visualizing curves.
*   **Phase 3:** Refactor `forecast.server.ts` to implement the Phase 1/2/3 mathematical branching logic.
*   **Phase 4:** Production deployment and cron job validation.
