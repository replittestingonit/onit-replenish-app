# Geographic & Seasonal Cold-Start Forecasting Framework

## 1. The Core Problem
When provisioning a new SKU (e.g., a new style of Santa Hat or a new brand of sunscreen), the system has **zero historical data** to analyze. Standard algorithms default to zero, leaving the inventory vulnerable to stockouts. 

Furthermore, demand is rarely flat. It is highly dependent on:
1. **Time of Year (Seasonality):** Santa hats peak in December.
2. **Geography (Location):** Sunscreen peaks in July in New York, but peaks in March (Spring Break) in Florida.

## 2. The Solution: "Demand Profiles"
Instead of waiting for history to accumulate, the user assigns a new SKU to a **Demand Profile** at the time of provisioning. A Demand Profile is a normalized curve (an index) that models the expected behavior of a product category in a specific region over a 12-month (or 52-week) period.

### How it Works (The Math)
When a new SKU is provisioned, the user provides two inputs:
1. **The Demand Profile:** (e.g., `Winter_Holiday_Apparel`, `Sunscreen_Florida`)
2. **Expected Baseline Volume:** (e.g., "I expect to sell 1,200 of these over their lifecycle/year").

The engine then distributes that 1,200 volume across the forward-looking calendar according to the Profile's curve. 

#### Example Curve: `Winter_Holiday_Apparel`
*   **Jan-Aug:** 0% of annual sales
*   **September:** 5% of annual sales (60 units) -> *~2 units/day*
*   **October:** 15% of annual sales (180 units) -> *~6 units/day*
*   **November:** 30% of annual sales (360 units) -> *~12 units/day*
*   **December:** 50% of annual sales (600 units) -> *~20 units/day*

The engine calculates the Daily Sales and Statistical Variance based purely on the curve, automatically generating the **2-Sigma Reorder Points** on Day 1.

## 3. Database Schema Extensions

To support this framework, the data model requires three new structures:

```prisma
// Represents a generic seasonal curve (e.g., "BBQ Grills", "Winter Gear")
model DemandProfile {
  id              String   @id @default(cuid())
  name            String   // "Winter Holiday Apparel"
  category        String   // "Apparel", "Sporting Goods"
  region          String?  // "US-NY", "US-FL", or null for Global
  
  // Normalized 12-month multipliers (must sum to 1.0 or 100%)
  janWeight       Float
  febWeight       Float
  // ...
  decWeight       Float
  
  skus            ReorderConfig[]
}

// Extends the existing ReorderConfig
model ReorderConfig {
  // ... existing fields ...
  
  // Cold-Start Provisioning
  demandProfileId String?
  demandProfile   DemandProfile? @relation(fields: [demandProfileId], references: [id])
  expectedAnnualVolume Int?      // The baseline used to scale the curve
  
  // Transition Phase
  transitionToActuals Boolean @default(true) // Should the engine blend out the profile as real data comes in?
}
```

## 4. Geographic Data Enrichment (AI Integration)
You do not need to manually create the curve for "BBQ Grills in New York." 
Because the ONIT application is already integrated with the Grok LLM architecture, we can leverage an **AI Profile Generator**.

**Workflow:**
1. User clicks "Create Demand Profile"
2. User types: `"Sunscreen in Florida"`
3. The LLM processes the query against generic retail and geographic weather/tourism datasets and instantly generates the 12-month weighting array.
4. *Result:* March (Spring Break) spikes to 15%, dips in early summer, spikes again in July.

## 5. The Transition Phase (Blending)
A crucial part of this framework is the hand-off. The Profile is a proxy. As the SKU actually starts selling, the system must blend the Profile's forecast with the Actual Sales data.
*   **Month 1:** Forecast is 100% Profile, 0% Actuals.
*   **Month 3:** Forecast is 50% Profile, 50% Actuals.
*   **Month 6:** The system fully graduates the SKU to the standard Year-Over-Year / Trailing algorithmic model because it now has enough real data to calculate true statistical variance.

## 6. Dynamic Baseline Re-anchoring (The Auto-Correction Engine)
The initial "Expected Annual Volume" (e.g., 1,200 units) is just an educated guess. If that guess is wrong, the forecast will rapidly deviate from reality. To fix this, the engine employs **Prorated Volume Correction**.

### The Scenario:
You provisioned a new SKU with an expected volume of 1,200 units. 
After 3 months, you have only sold 80 units (leaving 1,120 in stock). The original whim was vastly overestimated.

### The Mathematical Correction:
The engine continuously compares **Actual Sales** against the **Profile's Expected Percentage** for that timeframe.
1. The engine checks the Seasonal Profile. It sees that Months 1-3 were supposed to account for **25%** of the annual sales.
2. If 25% of the year = 80 actual units sold, the engine dynamically calculates the *true* annual volume: `80 / 0.25 = 320 units`.
3. **The Pivot:** The engine instantly discards the original 1,200 "whim" and replaces it with the newly anchored baseline of **320 units**. 
4. The remaining 9 months of the forecast are immediately recalculated using the 320 baseline. The predicted days of inventory skyrockets, and all Purchase Order triggers for this item are immediately silenced to prevent further spending on a dud product.

## 7. Categorical Proxy Demand & Cannibalization
A pure "whim" baseline (like 1,200) is a last resort. The most accurate way to provision a new SKU is to use **Categorical Proxy Demand**. Furthermore, adding new items to an existing category rarely increases total total sales proportionally; instead, it spreads the existing demand thinner (Cannibalization).

### The Bundle Approach
Instead of guessing a baseline for a single new SKU, the system groups SKUs into **Product Families** (e.g., "Sunscreen"). 
When you introduce 2 new sunscreen SKUs to your existing catalog of 5 sunscreens, the engine looks at the *aggregate* historical volume of the entire Sunscreen family.

### Handling Cannibalization
If the "Sunscreen" family traditionally sells 7,000 units a year:
1. **Old State:** 5 SKUs selling roughly 1,400 units each.
2. **New State:** You add 2 new SKUs, bringing the family to 7 SKUs.
3. **The Recalculation:** The engine assumes the total category demand remains 7,000. It automatically provisions the 2 *new* SKUs with a baseline of 1,000 units each (7,000 / 7). 
4. **The Cannibalization Correction:** Crucially, the engine automatically **downgrades** the forecast of the 5 *existing* SKUs from 1,400 down to 1,000. 

By forecasting at the *Category Level* and distributing downward, the system prevents you from blindly over-ordering the legacy items while ignoring the impact the new items will have on their sales velocity.

## 8. Advanced Market Phenomena (The Edge Cases)
Beyond seasonality and cannibalization, true enterprise forecasting must account for exogenous market factors. A robust system should give the owner the option to toggle or configure the following phenomena:

### 1. Promotional Scrubbing (The Spike Effect)
**The Problem:** You run a massive "Buy 1 Get 1 Free" flash sale over the weekend. You sell 3,000 units in 48 hours. If the algorithm blindly includes those 48 hours in your 90-day average, it will artificially inflate your daily sales velocity and trick the system into generating massive Purchase Orders the following week.
**The Solution:** An "Exclude Promotional Outliers" toggle. The engine identifies statistical anomalies (e.g., sales > 4σ above the mean) and scrubs them from the baseline calculation, ensuring the forecast remains anchored to organic demand.

### 2. Supply Chain Shock (Lead Time Variance)
**The Problem:** The current equation assumes a fixed Lead Time (e.g., 14 days). But what happens during Chinese New Year, port strikes, or global shipping crises? 
**The Solution:** Dynamic Lead Time Variance. Just as we calculate a 2-Sigma buffer for *Demand* volatility, the system should track historical PO fulfillment times and apply a standard deviation buffer to *Supply* volatility. If a supplier is notoriously late, the system automatically expands the safety buffer for their SKUs.

### 3. Complementary Goods (The Halo Effect)
**The Problem:** The opposite of cannibalization. If you run a marketing campaign that doubles the sales of Flashlights, the historical forecast for D-Cell Batteries will be entirely wrong (it will be too low).
**The Solution:** SKU Linkage. The owner maps accessories to hero products. When the forecast for the Hero SKU (Flashlight) spikes, the system automatically applies a proportional "Halo Multiplier" to the linked accessory (Batteries) before it stocks out.

### 4. The Obsolescence Curve (End-of-Life Phase)
**The Problem:** Products eventually die (e.g., iPhone 13 cases when the iPhone 15 launches). Standard algorithms will see a slow decline but keep reordering small batches as stock gets low, leaving you with dead inventory.
**The Solution:** An "End-of-Life (EOL)" toggle. When activated, the Reorder Point is permanently forced to 0, completely disabling all PO generation. The engine switches from "Maintain Stock" mode into "Liquidation/Sell-Through" tracking.

### 5. Hero Items & Presentation Minimums (The "Never Out" Rule)
**The Problem:** For some items (like Milk in a grocery store, or signature products), the cost of a stockout is not a lost sale; it's a *lost customer who will switch to a competitor*. Additionally, physical retail requires "Presentation Minimums" (e.g., a display looks broken if it has fewer than 40 units on it, even if the algorithm says you only need 10 to meet demand).
**The Solution:** A "Hero Item / Never Out" designation. This forces two overrides:
1. **The 6-Sigma Override:** It bypasses standard variance models and applies a 99.999% probability buffer, accepting mathematically inefficient inventory holding costs to guarantee customer retention.
2. **The Merchandising Floor:** It allows the manager to input a "Visual Minimum" (e.g., 40 units). The Reorder Point will never drop below this visual threshold, regardless of how low actual demand falls.

## 9. Plain-English UI & Grok AI Integration

### Hiding the Math (UI Translation)
Store managers (often with a 10th-grade math level) should never see the words "Statistical Variance" or "Standard Deviation." The UI must translate complex math into **Business Outcomes**.

**Instead of:** "Select Sigma Multiplier (1σ, 2σ, 3σ)"
**The UI Shows:** "Protection Level"
*   [   ] **Lean (Save Cash)** — *Accepts occasional stockouts to keep inventory costs as low as possible.*
*   [ x ] **Balanced** — *The recommended sweet spot. Protects against 95% of demand spikes.*
*   [   ] **Never Stock Out (High Cost)** — *Requires tying up maximum capital in inventory to guarantee you never run out.*

**Instead of:** "Enable Promotional Scrubbing"
**The UI Shows:** "Ignore Flash Sales"
*   *(Toggle)* "Don't let huge weekend sales trick the system into over-ordering for next month."

### The Grok AI Integration (Seasonal Curves)
To generate Geographic Seasonal Curves without burying the user in spreadsheets, the system leverages the Grok LLM.

**1. The Trigger Mechanism:**
*   **Manual (New SKU Provisioning):** When the manager adds a new product family, they can click "Generate Seasonal Curve." 
*   **Automated (Quarterly Audit):** Once every 3 months, a background cron job runs the entire catalog through Grok to see if macroeconomic or climate shifts require updating the regional curves.
*   **Rate Limiting:** Manual generations are capped at 20 per month per store to control API costs.

**2. The System Prompt (Behind the Scenes):**
```text
You are an expert enterprise supply chain analyst. 
The user is selling {Product_Category} in the geographic region of {Region}.
Analyze historical consumer purchasing behavior, regional weather patterns, and holiday impacts for this specific region.
Output ONLY a JSON array of 12 floats representing the percentage of annual sales expected in each month (Jan-Dec).
The 12 floats MUST sum exactly to 1.0. 
Example for Winter Coats in New York: [0.15, 0.12, 0.05, 0.0, 0.0, 0.0, 0.0, 0.05, 0.10, 0.15, 0.20, 0.18]
```

**3. The Outcome:**
The manager types "Winter Coats in New York". They wait 3 seconds. A beautiful bar chart appears showing the 12-month curve. They click "Approve," and the complex math is instantly mapped to their inventory engine without them ever seeing an equation.
