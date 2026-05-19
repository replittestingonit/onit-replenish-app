import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";

import { useLoaderData, useSubmit, useFetcher } from "@remix-run/react";
import { json } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let config = await prisma.appConfiguration.findUnique({ where: { shop } });
  if (!config) {
    config = await prisma.appConfiguration.create({ data: { shop } });
  }

  let rules = await prisma.securityRule.findMany({ where: { shop } });
  
  // Auto-seed the 5 default rules on first load
  if (rules.length === 0) {
    await prisma.securityRule.createMany({
      data: [
        {
          shop,
          name: 'Fringe Hours Activity',
          description: 'Flags any inventory adjustment made outside of normal operating hours.',
          triggerType: 'time_fringe',
          timeOpen: '09:00',
          timeClose: '17:00',
          isActive: true
        },
        {
          shop,
          name: 'Unmatched Consumption',
          description: 'Flags manual inventory deductions that do not match a Shopify order.',
          triggerType: 'unmatched',
          isActive: true
        },
        {
          shop,
          name: 'Manual Correction Spike',
          description: 'Flags manual inventory corrections exceeding standard loss limits.',
          triggerType: 'manual_correction',
          quantityThreshold: '5',
          isActive: true
        },
        {
          shop,
          name: 'High-Velocity Corrections',
          description: 'Flags multiple inventory adjustments occurring within a highly concentrated timeframe.',
          triggerType: 'velocity',
          isActive: true
        },
        {
          shop,
          name: 'Supplier Mismatch',
          description: 'Fires when receiving staff logs a physical discrepancy against a packing slip.',
          triggerType: 'supplier_mismatch',
          isActive: true
        }
      ]
    });
    rules = await prisma.securityRule.findMany({ where: { shop } });
  }
  const alerts = await prisma.triggeredAlert.findMany({ where: { shop }, include: { rule: true }, orderBy: { time: 'desc' } });
  const events = await prisma.inventoryEvent.findMany({ where: { shop }, orderBy: { time: 'desc' }, take: 1000 });

  const uniqueItemIds = Array.from(new Set(events.map(e => e.inventoryItemId)));
  const itemNames: Record<string, string> = {};

  await Promise.all(uniqueItemIds.map(async (id) => {
    try {
      const res = await admin.graphql(`
        query {
          inventoryItem(id: "gid://shopify/InventoryItem/${id}") {
            sku
            variant {
              sku
              title
              product { title }
            }
          }
        }
      `);
      const data = await res.json();
      const item = data.data?.inventoryItem;
      const variant = item?.variant;
      if (variant) {
        const pTitle = variant.product?.title || 'Unknown Product';
        const vTitle = variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : '';
        const skuVal = item.sku || variant.sku;
        const skuStr = skuVal ? ` (SKU: ${skuVal})` : '';
        itemNames[id] = `${pTitle}${vTitle}${skuStr}`;
      } else {
        itemNames[id] = `Unknown Item (ID: ${id})`;
      }
    } catch(e) {
      itemNames[id] = `Item ID: ${id}`;
    }
  }));
  const shopSlug = shop.replace('.myshopify.com', '');

  // Fetch PO-related notifications for "Orders" filter
  const pendingPOs = await prisma.purchaseOrder.findMany({
    where: { shop, status: { in: ['draft', 'sent', 'partially_received'] } },
    include: { supplier: true, lineItems: true },
    orderBy: { createdAt: 'desc' }
  });

  // Find overdue POs
  const now = new Date();
  const poAlerts = pendingPOs.map(po => {
    const isOverdue = po.expectedDate && new Date(po.expectedDate) < now && po.status === 'sent';
    const isDraft = po.status === 'draft';
    return {
      id: `po_${po.id}`,
      poId: po.id,
      poNumber: po.poNumber,
      supplier: po.supplier?.name || 'Unknown',
      status: po.status,
      totalUnits: po.totalUnits,
      receivedUnits: po.receivedUnits,
      totalCost: po.totalCost,
      createdBy: po.createdBy,
      expectedDate: po.expectedDate,
      isOverdue: !!isOverdue,
      isDraft,
      alertType: isDraft ? 'po_draft_created' : isOverdue ? 'po_overdue' : 'po_status',
      lineItems: po.lineItems.map(li => ({
        productName: li.productName, sku: li.sku,
        orderedQty: li.orderedQty, receivedQty: li.receivedQty
      }))
    };
  });

  return json({ config, rules, alerts, events, itemNames, shopSlug, poAlerts });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "updateConfig") {
    await prisma.appConfiguration.update({
      where: { shop },
      data: {
        emailAlertsEnabled: formData.get("emailAlertsEnabled") === "true",
        businessStart: formData.get("businessStart")?.toString(),
        businessEnd: formData.get("businessEnd")?.toString()
      }
    });
  } else if (actionType === "toggleAlertStatus") {
    await prisma.triggeredAlert.update({
      where: { id: formData.get("id").toString() },
      data: { status: formData.get("status").toString() }
    });
  } else if (actionType === "saveRule") {
    const id = formData.get("id")?.toString();
    const data = {
      name: formData.get("name").toString(),
      description: formData.get("description").toString(),
      triggerType: formData.get("triggerType").toString(),
      timeOpen: formData.get("timeOpen")?.toString() || null,
      timeClose: formData.get("timeClose")?.toString() || null,
      quantityThreshold: formData.get("quantityThreshold")?.toString() || null,
      haltFulfillment: formData.get("haltFulfillment") === "true",
    };
    if (id && !id.startsWith('new_') && !id.startsWith('r')) {
      await prisma.securityRule.update({ where: { id }, data });
    } else {
      await prisma.securityRule.create({ data: { shop, ...data } });
    }
  }

  return json({ success: true });
};


import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  IndexTable,
  Badge,
  Box,
  Divider,
  Button,
  InlineStack,
  Icon,
  Select,
  Modal,
  DataTable,
  Link,
  Tag,
  ButtonGroup,
  Autocomplete,
  FormLayout,
  TextField,
  ChoiceList,
  Checkbox,
  Scrollable,
  Tooltip,
  Banner,
} from '@shopify/polaris';
import { LockIcon, ShieldCheckMarkIcon, ArrowUpIcon, ArrowDownIcon, ChevronUpIcon, ChevronDownIcon, SearchIcon, ExportIcon } from '@shopify/polaris-icons';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';

const todayHourlyData = [
  { time: '00:00', total: 1200, protected: 1200 },
  { time: '01:00', total: 1200, protected: 1200 },
  { time: '02:00', total: 1200, protected: 1200 },
  { time: '03:00', total: 1200, protected: 1200 },
  { time: '04:00', total: 1200, protected: 1200 },
  { time: '05:00', total: 1200, protected: 1200 },
  { time: '06:00', total: 1200, protected: 1200 },
  { time: '07:00', total: 1198, protected: 1198 },
  { time: '08:00', total: 1195, protected: 1190 },
  { time: '09:00', total: 1190, protected: 1180 },
  { time: '10:00', total: 1185, protected: 1175 },
  { time: '11:00', total: 1180, protected: 1160 },
  { time: '12:00', total: 1175, protected: 1150 },
  { time: '13:00', total: 1185, protected: 1160 },
  { time: '14:00', total: 1180, protected: 1155 },
  { time: '15:00', total: 1170, protected: 1145 },
  { time: '16:00', total: 1160, protected: 1140 },
  { time: '17:00', total: 1155, protected: 1135 },
  { time: '18:00', total: 1150, protected: 1135 },
  { time: '19:00', total: 1150, protected: 1135 },
  { time: '20:00', total: 1150, protected: 1135 },
  { time: '21:00', total: 1150, protected: 1135 },
  { time: '22:00', total: 1150, protected: 1135 },
  { time: '23:00', total: 1150, protected: 1135 },
];

const chartDataByTimeframe: Record<string, any[]> = {
  today_24h: todayHourlyData,
  last_48_hours: [
    { time: 'Yesterday 00:00', total: 1250, protected: 1250 },
    { time: 'Yesterday 12:00', total: 1230, protected: 1225 },
    { time: 'Today 00:00', total: 1200, protected: 1200 },
    { time: 'Today 12:00', total: 1215, protected: 1200 },
  ],
  this_week: [
    { time: 'Mon', total: 1300, protected: 1290 },
    { time: 'Tue', total: 1280, protected: 1280 },
    { time: 'Wed', total: 1250, protected: 1250 },
    { time: 'Thu', total: 1200, protected: 1200 },
    { time: 'Fri', total: 1185, protected: 1185 },
  ],
  this_month: [
    { time: 'Week 1', total: 1500, protected: 1450 },
    { time: 'Week 2', total: 1400, protected: 1380 },
    { time: 'Week 3', total: 1300, protected: 1290 },
    { time: 'Week 4', total: 1185, protected: 1185 },
  ]
};

interface IndividualEvent {
  person: string;
  action: 'Replenished' | 'Consumed';
  quantity: number;
  reason: string;
  time: string;
  transactionId?: string;
  ruleTriggered?: string;
}

interface ItemSummary {
  id: string;
  productName: string;
  replenished: number;
  consumed: number;
  netChange: number;
  totalInventory: number;
  events: IndividualEvent[];
}

// Updated data structure for the Summary Table
const summaryDataByTimeframe: Record<string, ItemSummary[]> = {
  today: [
    {
      id: '1001',
      productName: 'Premium Shield Cases',
      replenished: 1,
      consumed: 2,
      netChange: -1,
      totalInventory: 145,
      events: [
        { person: 'Joe', action: 'Replenished', quantity: 1, reason: 'added to inventory', time: '14:05 PM' },
        { person: 'Hansen', action: 'Consumed', quantity: 1, reason: 'internet sale', time: '13:42 PM', transactionId: '#SHP-99234' },
        { person: 'Sue', action: 'Consumed', quantity: 1, reason: 'corrected inventory (removed)', time: '12:50 PM', ruleTriggered: 'Manual Correction Spike' },
      ]
    },
    {
      id: '1002',
      productName: 'Tempered Glass Protectors',
      replenished: 2,
      consumed: 3,
      netChange: -1,
      totalInventory: 320,
      events: [
        { person: 'Joe', action: 'Replenished', quantity: 2, reason: 'added to inventory', time: '09:00 AM', ruleTriggered: 'Fringe Hours Activity' },
        { person: 'Hansen', action: 'Consumed', quantity: 2, reason: 'specific Shopify transactions', time: '13:00 PM', transactionId: '#SHP-99235' },
        { person: 'Hansen', action: 'Consumed', quantity: 1, reason: 'sale with a customer in the store', time: '18:00 PM', ruleTriggered: 'Fringe Hours Activity' },
      ]
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `100${i + 3}`,
      productName: `Inventory Item Variant ${i + 1}`,
      replenished: Math.floor(Math.random() * 10) + 1,
      consumed: Math.floor(Math.random() * 5),
      netChange: Math.floor(Math.random() * 10) - 2,
      totalInventory: Math.floor(Math.random() * 300) + 50,
      events: [
        { person: 'Joe', action: 'Replenished' as const, quantity: 2, reason: 'morning restock', time: '08:30 AM' },
        { person: 'Sue', action: 'Consumed' as const, quantity: 1, reason: 'online sale', time: '11:45 AM', transactionId: `#SHP-100${i}` }
      ]
    }))
  ],
  last_48_hours: [
    {
      id: '2001',
      productName: 'Privacy Screen Pro',
      replenished: 50,
      consumed: 3,
      netChange: 47,
      totalInventory: 85,
      events: [
        { person: 'Sue', action: 'Replenished', quantity: 50, reason: 'received new shipment', time: '08:00 AM' },
        { person: 'Joe', action: 'Consumed', quantity: 3, reason: 'bulk store purchase', time: '09:15 AM' },
      ]
    },
    {
      id: '2002',
      productName: 'Premium Shield Cases',
      replenished: 10,
      consumed: 5,
      netChange: 5,
      totalInventory: 145,
      events: [
        { person: 'Hansen', action: 'Replenished', quantity: 10, reason: 'warehouse transfer', time: '10:00 AM' },
        { person: 'Joe', action: 'Consumed', quantity: 5, reason: 'online purchase', time: '14:30 PM', transactionId: '#SHP-99102' },
      ]
    }
  ],
  this_week: [
    {
      id: '3001',
      productName: 'Premium Shield Cases',
      replenished: 80,
      consumed: 45,
      netChange: 35,
      totalInventory: 145,
      events: [
        { person: 'Sue', action: 'Replenished', quantity: 80, reason: 'weekly shipment', time: 'Mon 08:00 AM' },
        { person: 'Joe', action: 'Consumed', quantity: 10, reason: 'store sales', time: 'Mon 14:15 PM' },
        { person: 'Hansen', action: 'Consumed', quantity: 5, reason: 'online sales', time: 'Tue 09:30 AM', transactionId: '#SHP-98402' },
        { person: 'Joe', action: 'Consumed', quantity: 20, reason: 'store sales', time: 'Wed 11:00 AM' },
        { person: 'Hansen', action: 'Consumed', quantity: 10, reason: 'online sales', time: 'Wed 16:45 PM', transactionId: '#SHP-98511' },
      ]
    }
  ],
  this_month: [
    {
      id: '4001',
      productName: 'Premium Shield Cases',
      replenished: 300,
      consumed: 250,
      netChange: 50,
      totalInventory: 145,
      events: [
        { person: 'Sue', action: 'Replenished', quantity: 300, reason: 'monthly restock', time: 'May 01 07:00 AM' },
        { person: 'Joe', action: 'Consumed', quantity: 50, reason: 'store sales', time: 'May 04 12:30 PM' },
        { person: 'Hansen', action: 'Consumed', quantity: 40, reason: 'online sales', time: 'May 06 15:20 PM', transactionId: '#SHP-97001' },
        { person: 'Joe', action: 'Consumed', quantity: 100, reason: 'store sales', time: 'May 10 10:15 AM' },
        { person: 'Hansen', action: 'Consumed', quantity: 60, reason: 'online sales', time: 'May 13 14:45 PM', transactionId: '#SHP-98112' },
      ]
    },
    {
      id: '4002',
      productName: 'Tempered Glass Protectors',
      replenished: 400,
      consumed: 380,
      netChange: 20,
      totalInventory: 320,
      events: [
        { person: 'Joe', action: 'Replenished', quantity: 400, reason: 'monthly restock', time: 'May 01 07:30 AM' },
        { person: 'Hansen', action: 'Consumed', quantity: 100, reason: 'store sales', time: 'May 02 09:00 AM' },
        { person: 'Sue', action: 'Consumed', quantity: 30, reason: 'online sales', time: 'May 05 11:20 AM', transactionId: '#SHP-97105' },
        { person: 'Hansen', action: 'Consumed', quantity: 200, reason: 'store sales', time: 'May 08 14:00 PM' },
        { person: 'Sue', action: 'Consumed', quantity: 50, reason: 'online sales', time: 'May 12 16:30 PM', transactionId: '#SHP-98234' },
      ]
    }
  ]
};

interface SecurityRule {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  triggerType?: string;
  timeOpen?: string;
  timeClose?: string;
  quantityThreshold?: string;
}

const presetRules: SecurityRule[] = [
  { id: 'r1', name: 'Fringe Hours Activity', description: 'Monitors early/late shifts', isActive: true, triggerType: 'time_fringe', timeOpen: '09:00', timeClose: '17:00' },
  { id: 'r2', name: 'Unmatched Consumption', description: 'Detects unaccounted inventory', isActive: true, triggerType: 'unmatched' },
  { id: 'r3', name: 'High-Velocity Outflow', description: 'Detects mass withdrawals', isActive: true, triggerType: 'velocity', quantityThreshold: '5' },
  { id: 'r4', name: 'Manual Correction Spike', description: 'Monitors manual adjustments', isActive: true, triggerType: 'manual_correction', quantityThreshold: '3' },
];

interface TriggeredAlert {
  id: string;
  time: string;
  ruleTriggered: string;
  person: string;
  productName: string;
  details: string;
  status: 'active' | 'silenced';
}

const initialAlerts: TriggeredAlert[] = [
  { id: 'a1', time: 'Today 08:35 AM', ruleTriggered: 'Fringe Hours Activity', person: 'Joe', productName: 'Tempered Glass Protectors', details: 'Added 2 units to inventory prior to 09:00 AM opening.', status: 'active' },
  { id: 'a2', time: 'Yesterday 18:00 PM', ruleTriggered: 'Fringe Hours Activity', person: 'Hansen', productName: 'Tempered Glass Protectors', details: 'Consumed 1 unit after hours (Store closed at 17:30).', status: 'active' },
  { id: 'a3', time: 'Monday 12:50 PM', ruleTriggered: 'Manual Correction Spike', person: 'Sue', productName: 'Premium Shield Cases', details: 'Corrected inventory (removed) by 1 unit.', status: 'active' },
];

function App() {
  const { config: dbConfig, rules: dbRules, alerts: dbAlerts, events: dbEvents, itemNames, shopSlug, poAlerts } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const fetcher = useFetcher();

  const [selectedTab, setSelectedTab] = useState(0);
  const [isExportMode, setIsExportMode] = useState(false);

  // "Orders" filter — sticky via localStorage
  const [showOrders, setShowOrders] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('onit_dashboard_showOrders') === 'true';
    }
    return false;
  });
  const toggleShowOrders = useCallback((checked: boolean) => {
    setShowOrders(checked);
    if (typeof window !== 'undefined') {
      localStorage.setItem('onit_dashboard_showOrders', checked.toString());
    }
  }, []);
  const [alerts, setAlerts] = useState(
    dbAlerts.map(a => ({
      id: a.id,
      time: new Date(a.time).toLocaleString(),
      ruleTriggered: a.rule?.name || 'Unknown Rule',
      person: a.person,
      productName: a.productName,
      details: a.details,
      status: a.status as 'active' | 'silenced',
      transactionId: a.transactionId
    }))
  );
  
  useEffect(() => {
    setAlerts(dbAlerts.map(a => ({
      id: a.id,
      time: new Date(a.time).toLocaleString(),
      ruleTriggered: a.rule?.name || 'Unknown Rule',
      person: a.person,
      productName: a.productName,
      details: a.details,
      status: a.status as 'active' | 'silenced',
      transactionId: a.transactionId
    })));
  }, [dbAlerts]);

  const [investigateAlert, setInvestigateAlert] = useState<any | null>(null);
  const [shareWith, setShareWith] = useState("owner");

  const [alertViewMode, setAlertViewMode] = useState<'active' | 'silenced'>('active');
  const [rules, setRules] = useState(dbRules.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      triggerType: r.triggerType,
      timeOpen: r.timeOpen || undefined,
      timeClose: r.timeClose || undefined,
      quantityThreshold: r.quantityThreshold || undefined
  })));
  
  useEffect(() => {
    setRules(dbRules.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      triggerType: r.triggerType,
      timeOpen: r.timeOpen || undefined,
      timeClose: r.timeClose || undefined,
      quantityThreshold: r.quantityThreshold || undefined
    })));
  }, [dbRules]);

  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleDescription, setNewRuleDescription] = useState('');
  const [newRuleTriggerType, setNewRuleTriggerType] = useState('time_fringe');
  const [timeOpen, setTimeOpen] = useState('09:00');
  const [timeClose, setTimeClose] = useState('17:00');
  const [quantityThreshold, setQuantityThreshold] = useState('');
  const [haltFulfillment, setHaltFulfillment] = useState(false);
  const [timeframe, setTimeframe] = useState(
    (typeof window !== 'undefined' ? localStorage.getItem('shopifyProtectionTimeframe') : null) || 'today'
  );
  const [todayViewMode, setTodayViewMode] = useState<'business' | '24h'>(
    ((typeof window !== 'undefined' ? localStorage.getItem('shopifyProtectionTodayViewMode') : null) as 'business' | '24h') || 'business'
  );
  const [isChartBanded, setIsChartBanded] = useState(
    (typeof window !== 'undefined' ? localStorage.getItem('shopifyProtectionIsChartBanded') : null) === 'true'
  );
  const [globalBusinessStart, setGlobalBusinessStart] = useState(
    dbConfig?.businessStart || '09:00'
  );
  const [globalBusinessEnd, setGlobalBusinessEnd] = useState(
    dbConfig?.businessEnd || '17:00'
  );

  const [graphViews, setGraphViews] = useState<any[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('shopifyProtectionGraphViews');
        return saved ? JSON.parse(saved) : [];
      } catch { return []; }
    }
    return [];
  });
  const [activeGraphViewId, setActiveGraphViewId] = useState('all');
  const [isGraphViewModalOpen, setIsGraphViewModalOpen] = useState(false);
  const [newGraphViewName, setNewGraphViewName] = useState('');
  const [newGraphViewProducts, setNewGraphViewProducts] = useState<string[]>([]);

  // Persist graph views
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('shopifyProtectionGraphViews', JSON.stringify(graphViews));
    }
  }, [graphViews]);

  // Dynamically map dbEvents to summaryDataByTimeframe
  const summaryDataByTimeframe: Record<string, any[]> = useMemo(() => {
    const map = new Map<string, any>();
    
    // Sort events chronologically (oldest first) to calculate differences correctly
    const chronologicalEvents = [...dbEvents].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    
    // Group events by item
    const eventsByItem = new Map<string, any[]>();
    chronologicalEvents.forEach(e => {
      const id = e.inventoryItemId;
      if (!eventsByItem.has(id)) eventsByItem.set(id, []);
      eventsByItem.get(id)!.push(e);
    });

    eventsByItem.forEach((events, itemId) => {
      const humanName = itemNames[itemId] || `Item ID: ${itemId}`;
      let consumed = 0;
      let replenished = 0;
      const formattedEvents: any[] = [];
      
      let previousAvailable = events[0].available; // Starting point

      events.forEach((e, index) => {
        // Calculate the difference from the previous event
        let quantityChange = 0;
        if (index > 0) {
          quantityChange = e.available - previousAvailable;
        } else {
          // For the very first event, we'll assume a change of 0 or estimate based on context
          quantityChange = 0; 
        }

        const isConsumed = quantityChange < 0;
        const absQuantity = Math.abs(quantityChange);

        if (isConsumed) consumed += absQuantity;
        else replenished += absQuantity;

        // Skip events with +0 quantity change so we don't clutter the UI
        if (absQuantity > 0) {
          let personName = 'Manual';
          const r = e.reason || '';
          
          if (r.includes('Staff:')) {
            // Legacy format: "Staff: Sue"
            const match = r.match(/Staff:\s*([^-|]+)/);
            if (match) personName = match[1].trim();
          } else if (r.startsWith('Manual Correction via App - ')) {
            // Adjust page: "Manual Correction via App - Sue (Damage)"
            const match = r.match(/Manual Correction via App - ([^(]+)/);
            if (match) personName = match[1].trim();
          } else if (r.startsWith('Inbound Receiving - ')) {
            // Receive page: "Inbound Receiving - Mike (PO-123)"
            const match = r.match(/Inbound Receiving - ([^(]+)/);
            if (match) personName = match[1].trim();
          } else if (r.includes('Internet Sale') || r.includes('Local Store Sale')) {
            // Sale via orders webhook
            personName = 'Shopify Store';
          } else if (e.transactionId) {
            // Has an order linked but reason wasn't updated yet
            personName = 'Shopify Store';
          }
          // Everything else stays "Manual"

          let matchedAlert = undefined;
          if (e.transactionId) {
             matchedAlert = dbAlerts.find(a => a.transactionId === e.transactionId);
          } else {
             matchedAlert = dbAlerts.find(a => 
               Math.abs(new Date(a.time).getTime() - new Date(e.time).getTime()) < 10000 &&
               a.productName.includes(itemId.replace('gid://shopify/InventoryItem/', ''))
             );
          }

          formattedEvents.push({
            person: personName,
            action: isConsumed ? 'Consumed' : 'Replenished',
            quantity: absQuantity,
            reason: e.reason || 'Webhook',
            time: new Date(e.time).toLocaleString(),
            transactionId: e.transactionId,
            inventoryItemId: e.inventoryItemId,
            referenceNumber: e.referenceNumber,
            isFullyMet: e.isFullyMet,
            ruleTriggered: matchedAlert?.rule?.name || undefined,
            totalInventoryAtTime: e.available
          });
        }
        
        previousAvailable = e.available;
      });

      map.set(itemId, {
        id: events[0].inventoryItemId,
        productName: humanName,
        replenished,
        consumed,
        netChange: replenished - consumed,
        totalInventory: events[events.length - 1].available, // Newest available
        events: formattedEvents.reverse() // Newest first for the UI
      });
    });

    let data = Array.from(map.values());
    
    // The dummy data overriding block was removed here to allow the real-world sandbox to accurately show
    // only the actual products currently tracked by the webhook.
    return { today: data, yesterday: data, this_week: data, this_month: data };
  }, [dbEvents]);
  
  // Dynamically map dbEvents to chartDataByTimeframe
  const chartDataByTimeframe: Record<string, any[]> = useMemo(() => {
    // Highly simplified graph representation for demo purposes based on DB events
    const today = Array.from({length: 24}).map((_, i) => {
      const hourEvents = dbEvents.filter(e => new Date(e.time).getHours() === i);
      const latest = hourEvents[0];
      const protectedVal = hourEvents.filter(e => e.isProtected)[0];
      return {
        time: `${i.toString().padStart(2, '0')}:00`,
        total: latest ? latest.available : undefined,
        protected: protectedVal ? protectedVal.available : undefined
      };
    });
    
    // Fill forward blanks for total if previous hour had data
    const oldestEvent = [...dbEvents].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())[0];
    let lastTotal = oldestEvent ? oldestEvent.available : 0;
    let lastProtected = oldestEvent ? oldestEvent.available : 0;
    for(let i=0; i<24; i++) {
      if(today[i].total !== undefined) lastTotal = today[i].total;
      else today[i].total = lastTotal;
      
      if(today[i].protected !== undefined) lastProtected = today[i].protected;
      else today[i].protected = lastTotal;
    }

    return { today, yesterday: today, this_week: today, this_month: today };
  }, [dbEvents]);

  const todayHourlyData = chartDataByTimeframe.today;
  const currentSummaryData = summaryDataByTimeframe[timeframe] || [];

  
  const currentChartData = useMemo(() => {
    let baseData = todayHourlyData;
    if (timeframe === 'today') {
      const currentHour = new Date().getHours();
      const blankedData = todayHourlyData.map((d, i) => {
        if (i > currentHour) {
          return { time: d.time, total: undefined, protected: undefined };
        }
        return { ...d };
      });

      if (todayViewMode === '24h') {
        baseData = blankedData;
      } else {
        const startHour = parseInt(globalBusinessStart.split(':')[0]);
        const endHour = parseInt(globalBusinessEnd.split(':')[0]);
        baseData = blankedData.filter((_, i) => i >= startHour && i <= endHour);
      }
    } else {
      baseData = chartDataByTimeframe[timeframe] || todayHourlyData;
    }

    if (activeGraphViewId !== 'all') {
      const activeView = graphViews.find(v => v.id === activeGraphViewId);
      if (activeView && activeView.products.length > 0) {
        const scaleFactor = Math.max(0.05, activeView.products.length / 10);
        return baseData.map(d => ({
          ...d,
          total: d.total !== undefined ? Math.round(d.total * scaleFactor) : undefined,
          protected: d.protected !== undefined ? Math.round(d.protected * scaleFactor) : undefined
        }));
      }
    }
    return baseData.map(d => ({ ...d }));
  }, [timeframe, todayViewMode, globalBusinessStart, globalBusinessEnd, activeGraphViewId, graphViews]);
  const activeAlertsCount = alerts.filter(a => a.status === 'active').length;

  const currentTotalInventory = useMemo(() => {
    const validData = [...todayHourlyData].reverse().find(d => d.total !== undefined);
    return validData ? validData.total : 0;
  }, [todayHourlyData]);

  const currentProtectedInventory = useMemo(() => {
    const validData = [...todayHourlyData].reverse().find(d => d.protected !== undefined);
    return validData ? validData.protected : 0;
  }, [todayHourlyData]);

  const varianceUnits = Math.abs(currentTotalInventory - currentProtectedInventory);
  const varianceRate = currentTotalInventory > 0 ? ((varianceUnits / currentTotalInventory) * 100).toFixed(1) : "0.0";
  
  const previousTotalInventory = useMemo(() => {
    const validData = [...todayHourlyData].reverse().slice(1).find(d => d.total !== undefined);
    return validData ? validData.total : currentTotalInventory;
  }, [todayHourlyData, currentTotalInventory]);

  const inventoryChangePercent = previousTotalInventory > 0 
    ? (((currentTotalInventory - previousTotalInventory) / previousTotalInventory) * 100).toFixed(1)
    : "0.0";
  const isInventoryUp = parseFloat(inventoryChangePercent) >= 0;
  const newAlertsBadgeText = activeAlertsCount > 0 ? `${activeAlertsCount} New` : "0 New";
  
  // Modal state
  const [activeModal, setActiveModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ItemSummary | null>(null);
  const [filteredPerson, setFilteredPerson] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [productFilter, setProductFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('shopifyProtectionProductFilter') || '';
    }
    return '';
  });
  const [personFilter, setPersonFilter] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('shopifyProtectionPersonFilter') || '';
    }
    return '';
  });

  // Persist filters
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('shopifyProtectionProductFilter', productFilter);
    }
  }, [productFilter]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('shopifyProtectionPersonFilter', personFilter);
    }
  }, [personFilter]);
  const [viewMode, setViewMode] = useState<'summary' | 'chronological'>(
    ((typeof window !== 'undefined' ? localStorage.getItem('shopifyProtectionPreferredViewMode') : null) as 'summary' | 'chronological') || 'summary'
  );
  const [onlyAlerted, setOnlyAlerted] = useState(false);
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(true);

  useEffect(() => {
    localStorage.setItem('shopifyProtectionPreferredViewMode', viewMode);
    setIsExportMode(false);
    setSelectedEvents([]);
  }, [viewMode]);

  const uniqueProducts = useMemo(() => {
    const products = new Set<string>();
    currentSummaryData.forEach(item => products.add(item.productName));
    return Array.from(products).map(p => ({ value: p, label: p }));
  }, [currentSummaryData]);

  const uniquePeople = useMemo(() => {
    const people = new Set<string>();
    currentSummaryData.forEach(item => item.events.forEach(e => people.add(e.person)));
    return Array.from(people).map(p => ({ value: p, label: p }));
  }, [currentSummaryData]);

  const productOptions = useMemo(() => {
    if (!productFilter) return uniqueProducts;
    return uniqueProducts.filter(o => o.label.toLowerCase().includes(productFilter.toLowerCase()));
  }, [uniqueProducts, productFilter]);

  const personOptions = useMemo(() => {
    if (!personFilter) return uniquePeople;
    return uniquePeople.filter(o => o.label.toLowerCase().includes(personFilter.toLowerCase()));
  }, [uniquePeople, personFilter]);

  const handleTimeframeChange = useCallback((value: string) => setTimeframe(value), []);
  const toggleModal = useCallback(() => setActiveModal((active) => !active), []);
  
  const openAddRuleModal = useCallback(() => {
    setEditingRuleId(null);
    setNewRuleName('');
    setNewRuleDescription('');
    setQuantityThreshold('');
    setTimeOpen('09:00');
    setTimeClose('17:00');
    setHaltFulfillment(false);
    setNewRuleTriggerType('time_fringe');
    setIsRuleModalOpen(true);
  }, []);

  const openEditRuleModal = useCallback((rule: SecurityRule) => {
    setEditingRuleId(rule.id);
    setNewRuleName(rule.name);
    setNewRuleDescription(rule.description);
    setNewRuleTriggerType(rule.triggerType || 'time_fringe');
    setQuantityThreshold(rule.quantityThreshold || '');
    setTimeOpen(rule.timeOpen || '09:00');
    setTimeClose(rule.timeClose || '17:00');
    setHaltFulfillment(rule.haltFulfillment || false);
    setIsRuleModalOpen(true);
  }, []);

  const closeRuleModal = useCallback(() => setIsRuleModalOpen(false), []);

  const handleSaveRule = useCallback(() => {
    if (newRuleName) {
      const newRule: SecurityRule = {
        id: editingRuleId || `r${Date.now()}`,
        name: newRuleName,
        description: newRuleDescription,
        isActive: true,
        triggerType: newRuleTriggerType,
        timeOpen,
        timeClose,
        quantityThreshold,
        haltFulfillment
      };

      const formData = new FormData();
      formData.append("actionType", "saveRule");
      if (editingRuleId) formData.append("id", editingRuleId);
      formData.append("name", newRuleName);
      formData.append("description", newRuleDescription);
      formData.append("triggerType", newRuleTriggerType);
      if (timeOpen) formData.append("timeOpen", timeOpen);
      if (timeClose) formData.append("timeClose", timeClose);
      if (quantityThreshold) formData.append("quantityThreshold", quantityThreshold);
      formData.append("haltFulfillment", haltFulfillment.toString());
      submit(formData, { method: "post" });

      closeRuleModal();
      
      // Keep optimistic UI update
      if (editingRuleId) {
        setRules(rules => rules.map(r => r.id === editingRuleId ? newRule : r));
      } else {
        setRules(rules => [...rules, newRule]);
      }
    }
  }, [editingRuleId, newRuleName, newRuleDescription, newRuleTriggerType, timeOpen, timeClose, quantityThreshold, haltFulfillment, closeRuleModal]);

  const handleSaveGraphView = useCallback(() => {
    if (newGraphViewName && newGraphViewProducts.length > 0) {
      if (graphViews.length >= 5) {
        alert("Maximum 5 saved views allowed.");
        return;
      }
      const newView = {
        id: `v${Date.now()}`,
        name: newGraphViewName,
        products: newGraphViewProducts
      };
      setGraphViews([...graphViews, newView]);
      setActiveGraphViewId(newView.id);
      setIsGraphViewModalOpen(false);
      setNewGraphViewName('');
      setNewGraphViewProducts([]);
    }
  }, [newGraphViewName, newGraphViewProducts, graphViews]);

  const handleDeleteGraphView = useCallback((id: string) => {
    setGraphViews(views => views.filter(v => v.id !== id));
    if (activeGraphViewId === id) setActiveGraphViewId('all');
  }, [activeGraphViewId]);

  const openDetails = (item: ItemSummary, person: string | null = null) => {
    setSelectedItem(item);
    setFilteredPerson(person);
    setActiveModal(true);
  };

  const resourceName = {
    singular: 'item summary',
    plural: 'item summaries',
  };

  const filteredSummaryData = useMemo(() => {
    return currentSummaryData.filter((item) => {
      const matchesProduct = productFilter === '' || item.productName.toLowerCase().includes(productFilter.toLowerCase());
      const matchesPerson = personFilter === '' || item.events.some(e => e.person.toLowerCase().includes(personFilter.toLowerCase()));
      const matchesAlert = !onlyAlerted || alerts.some(a => a.status === 'active' && a.productName === item.productName);
      
      return matchesProduct && matchesPerson && matchesAlert;
    });
  }, [currentSummaryData, productFilter, personFilter, onlyAlerted, alerts]);

  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const allResourcesSelected = filteredSummaryData.length > 0 && selectedResources.length === filteredSummaryData.length;


  const handleSelectionChange = useCallback((
    selectionType: any,
    isSelecting: boolean,
    selection?: string | [number, number],
  ) => {
    if (selectionType === 'all' || selectionType === 'page') {
      setSelectedResources(isSelecting ? filteredSummaryData.map(d => d.id) : []);
    } else if (selectionType === 'single' && typeof selection === 'string') {
      setSelectedResources(prev => 
        isSelecting ? [...prev, selection] : prev.filter(id => id !== selection)
      );
    }
  }, [filteredSummaryData]);

  const chronologicalEvents = useMemo(() => {
    const allEvents = filteredSummaryData.flatMap(item => 
      item.events
        .filter(e => personFilter === '' || e.person.toLowerCase().includes(personFilter.toLowerCase()))
        .filter(e => !onlyAlerted || e.ruleTriggered)
        .map(e => ({
          ...e,
          productName: item.productName,
          totalInventory: e.totalInventoryAtTime !== undefined ? e.totalInventoryAtTime : item.totalInventory,
          transactionId: e.transactionId,
          inventoryItemId: e.inventoryItemId,
          referenceNumber: e.referenceNumber,
          isFullyMet: e.isFullyMet,
          proofImage: e.proofImage,
          ruleTriggered: e.ruleTriggered
        }))
    );
    // Rough sort descending for mock data
    return allEvents.sort((a, b) => b.time.localeCompare(a.time));
  }, [filteredSummaryData, personFilter]);

  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);

  const handleEventSelectionChange = useCallback((
    selectionType: any,
    isSelecting: boolean,
    selection?: string | [number, number],
  ) => {
    if (selectionType === 'all' || selectionType === 'page') {
      setSelectedEvents(isSelecting ? chronologicalEvents.map((_, i) => `chrono-${i}`) : []);
    } else if (selectionType === 'single' && typeof selection === 'string') {
      setSelectedEvents(prev => 
        isSelecting ? [...prev, selection] : prev.filter(id => id !== selection)
      );
    }
  }, [chronologicalEvents]);

  const getShortRuleName = (ruleName: string) => {
    if (ruleName === 'Fringe Hours Activity') return 'Fringe Hours';
    if (ruleName === 'High-Velocity Outflow') return 'High Velocity';
    if (ruleName === 'Manual Correction Spike') return 'Manual Correction';
    return ruleName;
  };

  const chronologicalRowMarkup = chronologicalEvents.map((event, index) => {
    // Build a link: order page if there's a transactionId, product inventory page otherwise
    const tagUrl = event.transactionId
      ? `https://admin.shopify.com/store/${shopSlug}/orders?query=${encodeURIComponent(event.transactionId)}`
      : `https://admin.shopify.com/store/${shopSlug}/products?query=${encodeURIComponent(event.productName.split(' (SKU:')[0])}`;

    return (
      <IndexTable.Row id={`chrono-${index}`} key={index} position={index} selected={isExportMode ? selectedEvents.includes(`chrono-${index}`) : false}>
        <IndexTable.Cell>{event.time}</IndexTable.Cell>
        <IndexTable.Cell>
          {event.person === 'Manual' ? (
            <Tooltip content="Upgrade to WMS-Lite to see who made this change" preferredPosition="above">
              <Tag>{event.person}</Tag>
            </Tooltip>
          ) : !isExportMode ? (
            <span 
              role="link"
              tabIndex={0}
              style={{ cursor: 'pointer', display: 'inline-block' }}
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                window.open(tagUrl, '_blank');
              }}
            >
              <Tag>{event.person}</Tag>
            </span>
          ) : (
            <Tag>{event.person}</Tag>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Tooltip content={event.productName}>
            <div style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <Text variant="bodyMd" fontWeight="bold" as="span">{event.productName}</Text>
            </div>
          </Tooltip>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {event.ruleTriggered ? (
            <Badge tone="critical">{getShortRuleName(event.ruleTriggered)}</Badge>
          ) : (
            <span style={{ color: '#8c9196' }}>—</span>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={event.action === 'Replenished' ? 'success' : 'critical'}>{event.action === 'Replenished' ? 'Inventory In' : 'Inventory Out'}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={{ textAlign: 'right' }}>
            <Text variant="bodyMd" as="span" tone={event.action === 'Replenished' ? 'success' : 'critical'}>
              {event.action === 'Replenished' ? `+${event.quantity}` : `-${event.quantity}`}
            </Text>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {event.transactionId && !isExportMode ? (
            <InlineStack gap="100" blockAlign="center">
              <Text as="span" variant="bodyMd">{event.reason.replace('Location: ', '')}</Text>
              <span 
                role="link"
                tabIndex={0}
                style={{ color: '#2c6ecb', cursor: 'pointer', textDecoration: 'underline' }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  window.open(tagUrl, '_blank');
                }}
              >
                {event.transactionId}
              </span>
            </InlineStack>
          ) : event.transactionId ? (
            <InlineStack gap="100" blockAlign="center">
              <Text as="span" variant="bodyMd">{event.reason.replace('Location: ', '')}</Text>
              <Text as="span" variant="bodyMd" tone="subdued">{event.transactionId}</Text>
            </InlineStack>
          ) : (
            <Text as="span" variant="bodyMd">{event.reason.replace('Location: ', '')}</Text>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={{ textAlign: 'right' }}>
            <Text variant="bodyMd" fontWeight="bold" as="span">{event.totalInventory}</Text>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  const rowMarkup = filteredSummaryData.map(
    (item, index) => {
      // Extract unique contributors
      const contributors = Array.from(new Set(item.events.map(e => e.person)));

      return (
        <IndexTable.Row
          id={item.id}
          key={item.id}
          selected={selectedResources.includes(item.id)}
          position={index}
          onClick={() => openDetails(item)}
        >
          <IndexTable.Cell>
            <Tooltip content={item.productName}>
              <div style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <Text variant="bodyMd" fontWeight="bold" as="span">{item.productName}</Text>
              </div>
            </Tooltip>
          </IndexTable.Cell>
          {showDetails && (
            <>
              <IndexTable.Cell>
                <div style={{ textAlign: 'right' }}>
                  <Text variant="bodyMd" as="span" tone="success">
                    +{item.replenished}
                  </Text>
                </div>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <div style={{ textAlign: 'right' }}>
                  <Text variant="bodyMd" as="span" tone="critical">
                    -{item.consumed}
                  </Text>
                </div>
              </IndexTable.Cell>
            </>
          )}
          <IndexTable.Cell>
            <div style={{ textAlign: 'right' }}>
              <Text variant="bodyMd" as="span" tone={item.netChange > 0 ? 'success' : item.netChange < 0 ? 'critical' : 'base'}>
                {item.netChange > 0 ? `+${item.netChange}` : item.netChange}
              </Text>
            </div>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <div style={{ textAlign: 'right' }}>
              <Text variant="bodyMd" fontWeight="bold" as="span">
                {item.totalInventory}
              </Text>
            </div>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="100">
              {contributors.map(person => (
                <span key={person} onClick={(e) => { e.stopPropagation(); openDetails(item, person); }} style={{ cursor: 'pointer' }}>
                  <Tag>{person}</Tag>
                </span>
              ))}
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    },
  );

  // Prepare Modal Data
  const modalEvents = selectedItem 
    ? selectedItem.events.filter(e => (filteredPerson ? e.person === filteredPerson : true) && (!onlyAlerted || e.ruleTriggered))
    : [];

  const modalRows = modalEvents.map(event => [
    event.person,
    event.ruleTriggered ? <Badge tone="critical">{getShortRuleName(event.ruleTriggered)}</Badge> : <span style={{ color: '#8c9196' }}>—</span>,
    <Badge tone={event.action === 'Replenished' ? 'success' : 'critical'}>{event.action === 'Replenished' ? 'Inventory In' : 'Sold'}</Badge>,
    event.action === 'Replenished' ? `+${event.quantity}` : `-${event.quantity}`,
    event.transactionId ? (
      <InlineStack gap="100" blockAlign="center">
        <Text as="span" variant="bodyMd">{event.reason.replace('Location: ', '')}</Text>
        <Link url={`https://admin.shopify.com/orders/${event.transactionId.replace('#', '')}`} target="_blank">
          {event.transactionId}
        </Link>
      </InlineStack>
    ) : (
      event.reason.replace('Location: ', '')
    ),
    event.time
  ]);

  const executeExport = (dataToExport: any[], filename: string) => {
    if (dataToExport.length === 0) return;
    const headers = Object.keys(dataToExport[0]);
    const csvRows = [headers.join(',')];
    for (const row of dataToExport) {
      const values = headers.map(header => {
        const escaped = ('' + row[header]).replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    }
    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleExportSelected = useCallback((selectedIds: string[]) => {
    const selectedItems = filteredSummaryData.filter(item => selectedIds.includes(item.id));
    const dataToExport = selectedItems.map(item => ({
      Product: item.productName,
      Replenished: item.replenished,
      Consumed: item.consumed,
      'Net Change': item.netChange,
      'Current Total': item.totalInventory,
      Contributors: Array.from(new Set(item.events.map(e => e.person))).join('; '),
    }));
    executeExport(dataToExport, `targeted_audit_${timeframe}.csv`);
  }, [filteredSummaryData, timeframe]);

  const handleExport = useCallback(() => {
    let dataToExport: any[] = [];
    let filename = 'export.csv';

    if (selectedTab === 0) {
      if (viewMode === 'summary') {
        dataToExport = filteredSummaryData.map(item => ({
          Product: item.productName,
          Replenished: item.replenished,
          Consumed: item.consumed,
          'Net Change': item.netChange,
          'Current Total': item.totalInventory,
          Contributors: Array.from(new Set(item.events.map(e => e.person))).join('; '),
        }));
        filename = `inventory_summary_${timeframe}.csv`;
      } else {
        const eventsToExport = selectedEvents.length > 0
          ? chronologicalEvents.filter((_, i) => selectedEvents.includes(`chrono-${i}`))
          : chronologicalEvents;
          
        dataToExport = eventsToExport.map(event => ({
          Time: event.time,
          Person: event.person,
          Product: event.productName,
          Action: event.action,
          Quantity: event.action === 'Replenished' ? `+${event.quantity}` : `-${event.quantity}`,
          Location: event.reason.replace('Location: ', ''),
          'Transaction ID': event.transactionId || '',
          'Inbound Reference #': event.referenceNumber || '',
          'Fully Met': event.referenceNumber ? (event.isFullyMet ? 'Yes' : 'No') : '',
          'Proof Document': event.proofImage || '',
          'Current Total': event.totalInventory,
        }));
        filename = `inventory_chronological_${timeframe}.csv`;
      }
    } else {
      dataToExport = alerts.filter(a => a.status === alertViewMode).map(alert => ({
        Time: alert.time,
        Rule: alert.ruleTriggered,
        Person: alert.person,
        Product: alert.productName,
        Details: alert.details,
      }));
      filename = 'active_alerts.csv';
    }

    executeExport(dataToExport, filename);
  }, [selectedTab, viewMode, filteredSummaryData, chronologicalEvents, alerts, alertViewMode, timeframe]);

  const timeframeLabel = timeframe === 'today' ? 'today' : timeframe === 'last_48_hours' ? 'past 48h' : timeframe === 'this_week' ? 'this week' : 'this month';

  const summaryPromotedBulkActions = useMemo(() => [
    {
      content: 'Monitor in Graph',
      onAction: () => {
        const selectedProductIds = allResourcesSelected 
          ? filteredSummaryData.map(d => d.id) 
          : selectedResources;
        const productNames = filteredSummaryData
          .filter(item => selectedProductIds.includes(item.id))
          .map(item => item.productName);
        
        setNewGraphViewName(`Monitor ${productNames.length} Items`);
        setNewGraphViewProducts(productNames);
        setIsGraphViewModalOpen(true);
      },
    },
    {
      content: 'Export Selected',
      onAction: () => {
        const selectedIds = allResourcesSelected 
          ? filteredSummaryData.map(d => d.id) 
          : selectedResources;
        handleExportSelected(selectedIds as string[]);
      },
    },
  ], [allResourcesSelected, filteredSummaryData, selectedResources, handleExportSelected]);

  const summaryHeadings = useMemo(() => [
    { id: 'product', title: 'Product' },
    ...(showDetails ? [{ id: 'replenished', title: <div style={{textAlign: 'right'}}>Inventory In</div>, alignment: 'end' }, { id: 'consumed', title: <div style={{textAlign: 'right'}}>Sold</div>, alignment: 'end' }] : []),
    { 
      id: 'net-change-heading',
      alignment: 'end',
      title: (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button 
            variant="plain" 
            onClick={() => setShowDetails(!showDetails)}
            icon={showDetails ? ChevronUpIcon : ChevronDownIcon}
          >
            Net Change
          </Button>
        </div>
      ) 
    },
    { id: 'current', title: 'Current Total', alignment: 'end' },
    { id: 'contributors', title: 'Contributors' },
  ], [onlyAlerted, showDetails]);

  const chronologicalHeadings = useMemo(() => [
    { id: 'time', title: 'Time & Day' },
    { id: 'person', title: 'Person' },
    { id: 'product', title: 'Product' },
    { id: 'rule', title: 'Rule Triggered' },
    { id: 'action', title: 'Action' },
    { id: 'quantity', title: 'Quantity', alignment: 'end' },
    { id: 'location', title: 'Location' },
    { id: 'current', title: 'Current Total', alignment: 'end' },
  ], [onlyAlerted]);

  return (
    <Page fullWidth>
      {selectedTab === 0 ? (
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
            {/* Header Actions */}
            <Card padding="400">
              <Box paddingBlockEnd="400">
                <InlineStack align="space-between" blockAlign="center">
                  <ButtonGroup variant="segmented">
                    <Button pressed={viewMode === 'summary'} onClick={() => setViewMode('summary')}>Summary</Button>
                    <Button pressed={viewMode === 'chronological'} onClick={() => setViewMode('chronological')}>Chronological</Button>
                  </ButtonGroup>
                  <InlineStack gap="400" blockAlign="center">
                    <Checkbox label="Alerts Only" checked={onlyAlerted} onChange={setOnlyAlerted} />
                    <Autocomplete
                      options={productOptions}
                      selected={[productFilter]}
                      onSelect={(selected) => setProductFilter(selected[0])}
                      textField={
                        <Autocomplete.TextField
                          label="Filter products"
                          labelHidden
                          value={productFilter}
                          onChange={(value) => setProductFilter(value)}
                          prefix={<Icon source={SearchIcon} />}
                          placeholder="Search products"
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => setProductFilter('')}
                        />
                      }
                    />
                    <Autocomplete
                      options={personOptions}
                      selected={[personFilter]}
                      onSelect={(selected) => setPersonFilter(selected[0])}
                      textField={
                        <Autocomplete.TextField
                          label="Filter users"
                          labelHidden
                          value={personFilter}
                          onChange={(value) => setPersonFilter(value)}
                          prefix={<Icon source={SearchIcon} />}
                          placeholder="Search users"
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => setPersonFilter('')}
                        />
                      }
                    />
                    <Select
                      label="Timeframe"
                      labelHidden
                      options={[
                        {label: 'Today', value: 'today'},
                        {label: 'Last 48 Hours', value: 'last_48_hours'},
                        {label: 'This Week', value: 'this_week'},
                        {label: 'This Month', value: 'this_month'},
                      ]}
                      value={timeframe}
                      onChange={handleTimeframeChange}
                    />
                    {viewMode === 'chronological' && isExportMode ? (
                      <ButtonGroup>
                        <Button onClick={() => {
                          // Export selected (or all if none selected)
                          const eventsToExport = selectedEvents.length > 0
                            ? chronologicalEvents.filter((_, i) => selectedEvents.includes(`chrono-${i}`))
                            : chronologicalEvents;
                          const dataToExport = eventsToExport.map(event => ({
                            Time: event.time,
                            Person: event.person,
                            Product: event.productName,
                            Action: event.action,
                            Quantity: event.action === 'Replenished' ? `+${event.quantity}` : `-${event.quantity}`,
                            Location: event.reason.replace('Location: ', ''),
                            'Transaction ID': event.transactionId || '',
                            'Inbound Reference #': event.referenceNumber || '',
                            'Fully Met': event.referenceNumber ? (event.isFullyMet ? 'Yes' : 'No') : '',
                            'Proof Document': event.proofImage || '',
                            'Current Total': event.totalInventory,
                          }));
                          executeExport(dataToExport, `inventory_chronological_${timeframe}.csv`);
                          setIsExportMode(false);
                          setSelectedEvents([]);
                        }} variant="primary" icon={ExportIcon}>
                          Download CSV {selectedEvents.length > 0 ? `(${selectedEvents.length})` : '(All)'}
                        </Button>
                        <Button onClick={() => { setIsExportMode(false); setSelectedEvents([]); }}>
                          Cancel
                        </Button>
                      </ButtonGroup>
                    ) : (
                      <Button onClick={() => {
                        if (viewMode === 'chronological') {
                          setIsExportMode(true);
                          setSelectedEvents([]);
                        } else {
                          handleExport();
                        }
                      }} icon={ExportIcon} variant="primary">
                        Export Report
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>
              </Box>
              <div style={{ maxHeight: '400px', overflowY: 'auto', transform: 'translateZ(0)' }}>
                {viewMode === 'summary' ? (
                  <IndexTable
                    resourceName={resourceName}
                    itemCount={filteredSummaryData.length}
                    selectedItemsCount={
                      allResourcesSelected ? 'All' : selectedResources.length
                    }
                    onSelectionChange={handleSelectionChange}
                    promotedBulkActions={summaryPromotedBulkActions}
                    headings={summaryHeadings as any}
                  >
                    {rowMarkup}
                  </IndexTable>
                ) : isExportMode ? (
                  <IndexTable
                    resourceName={{ singular: 'event', plural: 'events' }}
                    itemCount={chronologicalEvents.length}
                    selectedItemsCount={
                      chronologicalEvents.length > 0 && selectedEvents.length === chronologicalEvents.length ? 'All' : selectedEvents.length
                    }
                    onSelectionChange={handleEventSelectionChange}
                    headings={chronologicalHeadings as any}
                  >
                    {chronologicalRowMarkup}
                  </IndexTable>
                ) : (
                  <IndexTable
                    resourceName={{ singular: 'event', plural: 'events' }}
                    itemCount={chronologicalEvents.length}
                    selectable={false}
                    headings={chronologicalHeadings as any}
                  >
                    {chronologicalRowMarkup}
                  </IndexTable>
                )}
              </div>
            </Card>
            {/* Top Stat Cards */}
            <InlineStack gap="400" wrap={false} align="space-evenly">
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Tooltip content="The system's calculated quantity based on recorded sales and received shipments.">
                        <Text variant="headingSm" as="h3" tone="subdued">
                          <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Expected Inventory</span>
                        </Text>
                      </Tooltip>
                      <Icon source={ShieldCheckMarkIcon} tone="success" />
                    </InlineStack>
                    <InlineStack align="start" blockAlign="center" gap="200">
                      <Text variant="heading3xl" as="h2">{currentTotalInventory.toLocaleString()}</Text>
                      <Badge tone={isInventoryUp ? "success" : "critical"} icon={isInventoryUp ? ArrowUpIcon : ArrowDownIcon}>{`${Math.abs(parseFloat(inventoryChangePercent))}% ${timeframeLabel}`}</Badge>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </div>
              <div 
                style={{ flex: 1, cursor: 'pointer', padding: activeAlertsCount > 0 ? '4px' : '0' }}
                className={activeAlertsCount > 0 ? "alert-pulse-card" : ""}
                onClick={() => setSelectedTab(1)}
                title="Click to view active alerts"
              >
                <div style={{ pointerEvents: 'none', height: '100%' }}>
                  <Card>
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Tooltip content="Security warnings triggered by unauthorized or suspicious inventory changes.">
                          <Text variant="headingSm" as="h3" tone={activeAlertsCount > 0 ? "critical" : "subdued"}>
                            <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Active Alerts</span>
                          </Text>
                        </Tooltip>
                        <Text variant="bodySm" as="span" tone="subdued">View Alerts ➔</Text>
                      </InlineStack>
                      <InlineStack align="start" blockAlign="center" gap="200">
                        <Text variant="heading3xl" as="h2">{activeAlertsCount}</Text>
                        {activeAlertsCount > 0 ? (
                          <Badge tone="critical" icon={ArrowUpIcon}>{newAlertsBadgeText}</Badge>
                        ) : (
                          <Badge tone="success" icon={ArrowDownIcon}>{newAlertsBadgeText}</Badge>
                        )}
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Tooltip content="The discrepancy between expected and physical inventory counts.">
                        <Text variant="headingSm" as="h3" tone="subdued">
                          <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Inventory Variance</span>
                        </Text>
                      </Tooltip>
                      <Icon source={LockIcon} tone="base" />
                    </InlineStack>
                    <InlineStack align="start" blockAlign="center" gap="200">
                      <Text variant="heading3xl" as="h2">{varianceRate}%</Text>
                      <Text variant="bodyMd" as="span" tone="subdued">({varianceUnits} Units)</Text>
                      <Badge tone="success" icon={ArrowDownIcon}>{`${varianceRate}% ${timeframeLabel}`}</Badge>
                    </InlineStack>
                  </BlockStack>
                </Card>
              </div>
              <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => { toggleShowOrders(true); setSelectedTab(1); }} title="Click to view purchase orders">
                <Card>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Tooltip content="Active purchase orders requiring attention.">
                        <Text variant="headingSm" as="h3" tone={poAlerts && poAlerts.some((p: any) => p.isOverdue) ? 'critical' : 'subdued'}>
                          <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Open POs</span>
                        </Text>
                      </Tooltip>
                      <Text variant="bodySm" as="span" tone="subdued">View POs ➔</Text>
                    </InlineStack>
                    <InlineStack align="start" blockAlign="center" gap="200">
                      <Text variant="heading3xl" as="h2">{poAlerts ? poAlerts.length : 0}</Text>
                      {poAlerts && poAlerts.filter((p: any) => p.isOverdue).length > 0 ? (
                        <Badge tone="critical">{poAlerts.filter((p: any) => p.isOverdue).length} Overdue</Badge>
                      ) : poAlerts && poAlerts.filter((p: any) => p.isDraft).length > 0 ? (
                        <Badge tone="attention">{poAlerts.filter((p: any) => p.isDraft).length} Drafts</Badge>
                      ) : (
                        <Badge tone="success">All Clear</Badge>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Card>
              </div>
            </InlineStack>

            {/* Main Chart Card */}
            <Card padding="0">
              <Box padding="400">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'nowrap', gap: '16px', width: '100%', overflowX: 'auto' }}>
                  <Text variant="headingMd" as="h2" truncate>
                    <Tooltip content="The system's calculated quantity based on recorded sales and received shipments.">
                      <span style={{ color: '#e55f00', cursor: 'help', borderBottom: '1px dotted #e55f00' }}>Expected Inventory</span>
                    </Tooltip> vs <Tooltip content="The actual counted quantity of items on your warehouse shelves.">
                      <span style={{ color: '#008060', cursor: 'help', borderBottom: '1px dotted #008060' }}>Physical Inventory</span>
                    </Tooltip>
                  </Text>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Select
                        label="Graph View"
                        labelHidden
                        options={[
                          { label: 'All Products', value: 'all' },
                          ...graphViews.map(v => ({ label: v.name, value: v.id })),
                          { label: '+ Create New View', value: 'create_new' },
                          ...(activeGraphViewId !== 'all' ? [{ label: '- Delete Current View', value: 'delete_current' }] : [])
                        ]}
                        value={activeGraphViewId}
                        onChange={(val) => {
                          if (val === 'create_new') {
                            setIsGraphViewModalOpen(true);
                          } else if (val === 'delete_current') {
                            handleDeleteGraphView(activeGraphViewId);
                          } else {
                            setActiveGraphViewId(val);
                          }
                        }}
                      />
                    </div>

                    {timeframe === 'today' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        {todayViewMode === 'business' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Text variant="bodySm" as="span" tone="subdued">Hours:</Text>
                            <input 
                              type="time" 
                              value={globalBusinessStart} 
                              onChange={(e) => setGlobalBusinessStart(e.target.value)} 
                              style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #c9cccf', fontSize: '13px' }}
                            />
                            <Text variant="bodySm" as="span" tone="subdued">to</Text>
                            <input 
                              type="time" 
                              value={globalBusinessEnd} 
                              onChange={(e) => setGlobalBusinessEnd(e.target.value)} 
                              style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #c9cccf', fontSize: '13px' }}
                            />
                          </div>
                        )}
                        <ButtonGroup variant="segmented">
                          <Button pressed={todayViewMode === 'business'} onClick={() => setTodayViewMode('business')}>Business Hours</Button>
                          <Button pressed={todayViewMode === '24h'} onClick={() => setTodayViewMode('24h')}>24 Hours</Button>
                        </ButtonGroup>
                      </div>
                    )}
                  </div>
                </div>
              </Box>
              <Divider />
              <Box padding="400" minHeight="350px">
                {currentChartData.some(d => d.total !== undefined || d.protected !== undefined) ? (
                  <div onClick={() => setIsChartBanded(!isChartBanded)} style={{ cursor: 'pointer' }} title="Click graph to toggle precision zoom">
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={currentChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#e55f00" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#e55f00" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorProtected" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#008060" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#008060" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                        <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#616a75', fontSize: 12 }} />
                        <YAxis domain={isChartBanded ? ['dataMin - 10', 'dataMax + 10'] : [0, 'auto']} axisLine={false} tickLine={false} tick={{ fill: '#616a75', fontSize: 12 }} />
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e5e7" />
                      <RechartsTooltip 
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' }}
                      />
                      <Area type="monotone" dataKey="total" name="Expected Inventory" stroke="#e55f00" strokeWidth={2} fillOpacity={1} fill="url(#colorTotal)" />
                      <Area type="monotone" dataKey="protected" name="Physical Inventory" stroke="#008060" strokeWidth={2} fillOpacity={1} fill="url(#colorProtected)" />
                    </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px dashed #c9cccf' }}>
                    <Icon source={SearchIcon} tone="subdued" />
                    <div style={{ marginTop: '12px' }}>
                      <Text variant="headingMd" as="h3" alignment="center" tone="subdued">No activity recorded yet</Text>
                    </div>
                    <div style={{ marginTop: '4px' }}>
                      <Text variant="bodyMd" as="p" alignment="center" tone="subdued">There is no inventory data available for the selected timeframe or business hours.</Text>
                    </div>
                  </div>
                )}
              </Box>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>
        ) : (
          <Layout>
            <Layout.Section>
              <BlockStack gap="400">
                <InlineStack>
                  <Button size="large" onClick={() => setSelectedTab(0)}>&larr; Return to Dashboard</Button>
                </InlineStack>
                {/* Active Alerts Table */}
                <Card padding="0">
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="400" blockAlign="center">
                        <Tooltip content="A detailed log of all security events requiring owner investigation.">
                          <Text variant="headingMd" as="h2">
                            <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Triggered Alerts</span>
                          </Text>
                        </Tooltip>
                        <ButtonGroup variant="segmented">
                          <Button pressed={alertViewMode === 'active'} onClick={() => setAlertViewMode('active')}>Active</Button>
                          <Button pressed={alertViewMode === 'silenced'} onClick={() => setAlertViewMode('silenced')}>Silenced</Button>
                        </ButtonGroup>
                        <Checkbox label={`📋 Orders${poAlerts && poAlerts.length > 0 ? ` (${poAlerts.length})` : ''}`} checked={showOrders} onChange={toggleShowOrders} />
                      </InlineStack>
                      {!showOrders && alertViewMode === 'active' && (
                        <Button tone="critical" onClick={() => setAlerts(al => al.map(a => a.status === 'active' ? { ...a, status: 'silenced' } : a))}>Clear All</Button>
                      )}
                    </InlineStack>
                  </Box>

                  {/* PO Orders View */}
                  {showOrders ? (
                    <Box padding="400">
                      <BlockStack gap="400">
                        {/* Auto-PO notification banners */}
                        {poAlerts && poAlerts.filter((po: any) => po.createdBy === 'System (Low Stock Alert)' && po.isDraft).length > 0 && (
                          <Banner tone="warning" title="Auto-Generated POs Need Review">
                            <p>{poAlerts.filter((po: any) => po.createdBy === 'System (Low Stock Alert)' && po.isDraft).length} draft PO(s) were auto-created due to low stock alerts. Review and approve them in <a href="/app/purchase-orders">Purchase Orders</a>.</p>
                          </Banner>
                        )}
                        {poAlerts && poAlerts.filter((po: any) => po.isOverdue).length > 0 && (
                          <Banner tone="critical" title="Overdue Purchase Orders">
                            <p>{poAlerts.filter((po: any) => po.isOverdue).length} PO(s) are past their expected delivery date. Follow up with suppliers.</p>
                          </Banner>
                        )}
                        {poAlerts && poAlerts.filter((po: any) => po.createdBy === 'System (Forecast Reorder)' && po.isDraft).length > 0 && (
                          <Banner tone="info" title="Forecast-Generated POs">
                            <p>{poAlerts.filter((po: any) => po.createdBy === 'System (Forecast Reorder)' && po.isDraft).length} draft PO(s) were created from demand forecast recommendations.</p>
                          </Banner>
                        )}
                        {poAlerts && poAlerts.length > 0 ? (
                          poAlerts.map((po: any) => (
                            <Card key={po.id} padding="400">
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="200">
                                  <InlineStack gap="200" blockAlign="center">
                                    <Text as="span" variant="headingMd">
                                      {po.isDraft ? '📝' : po.isOverdue ? '⚠️' : '📋'} {po.poNumber}
                                    </Text>
                                    <Badge tone={po.isDraft ? 'info' : po.isOverdue ? 'critical' : po.status === 'partially_received' ? 'warning' : 'attention'}>
                                      {po.isDraft ? 'Draft — Needs Approval' : po.isOverdue ? 'OVERDUE' : po.status === 'partially_received' ? 'Partially Received' : 'Sent'}
                                    </Badge>
                                  </InlineStack>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    Supplier: <strong>{po.supplier}</strong> · {po.receivedUnits}/{po.totalUnits} units received · ${po.totalCost.toFixed(2)}
                                  </Text>
                                  <Text as="p" variant="bodySm" tone="subdued">
                                    Created by: {po.createdBy}
                                    {po.expectedDate ? ` · Expected: ${new Date(po.expectedDate).toLocaleDateString()}` : ''}
                                  </Text>
                                  {po.lineItems && po.lineItems.length > 0 && (
                                    <BlockStack gap="100">
                                      {po.lineItems.slice(0, 3).map((li: any, i: number) => (
                                        <Text key={i} as="p" variant="bodySm">
                                          • {li.productName}{li.sku ? ` (${li.sku})` : ''} — {li.receivedQty}/{li.orderedQty}
                                        </Text>
                                      ))}
                                      {po.lineItems.length > 3 && (
                                        <Text as="p" variant="bodySm" tone="subdued">+ {po.lineItems.length - 3} more items</Text>
                                      )}
                                    </BlockStack>
                                  )}
                                </BlockStack>
                                <InlineStack gap="200">
                                  {po.isDraft && (
                                    <Button url="/app/purchase-orders" size="slim">Review & Approve</Button>
                                  )}
                                  {po.isOverdue && (
                                    <Badge tone="critical">Past Due</Badge>
                                  )}
                                </InlineStack>
                              </InlineStack>
                            </Card>
                          ))
                        ) : (
                          <Banner tone="success"><p>No pending purchase order actions. All POs are up to date.</p></Banner>
                        )}
                      </BlockStack>
                    </Box>
                  ) : (
                    <IndexTable
                      resourceName={{ singular: 'alert', plural: 'alerts' }}
                      itemCount={alerts.filter(a => a.status === alertViewMode).length}
                      headings={[
                        { title: 'Time' },
                        { title: 'Rule Triggered' },
                        { title: 'Person' },
                        { title: 'Product' },
                        { title: 'Details' },
                        { title: 'Action' },
                      ]}
                      selectable={false}
                    >
                      {alerts.filter(a => a.status === alertViewMode).map((alert, index) => (
                        <IndexTable.Row id={alert.id} key={alert.id} position={index}>
                          <IndexTable.Cell>{alert.time}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <Badge tone={alert.status === 'active' ? "critical" : undefined}>{getShortRuleName(alert.ruleTriggered)}</Badge>
                          </IndexTable.Cell>
                          <IndexTable.Cell><Tag>{alert.person}</Tag></IndexTable.Cell>
                          <IndexTable.Cell><Text variant="bodyMd" fontWeight="bold" as="span">{alert.productName}</Text></IndexTable.Cell>
                          <IndexTable.Cell>{alert.details}</IndexTable.Cell>
                          <IndexTable.Cell>
                            <InlineStack gap="200">
                              <Button size="slim" onClick={() => setInvestigateAlert(alert)}>Investigate</Button>
                              {alert.status === 'active' ? (
                                <Button variant="plain" tone="critical" onClick={() => setAlerts(al => al.map(a => a.id === alert.id ? { ...a, status: 'silenced' } : a))}>Silence</Button>
                              ) : (
                                <Button variant="plain" onClick={() => setAlerts(al => al.map(a => a.id === alert.id ? { ...a, status: 'active' } : a))}>Restore</Button>
                              )}
                            </InlineStack>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  )}
                </Card>

                {/* Security Rules Engine */}
                <Card padding="0">
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Tooltip content="Automated heuristic rules that monitor and flag suspicious inventory behavior.">
                        <Text variant="headingMd" as="h2">
                          <span style={{ cursor: 'help', borderBottom: '1px dotted #8c9196' }}>Security Rules Engine</span>
                        </Text>
                      </Tooltip>
                      <Button variant="primary" onClick={openAddRuleModal}>Add New Rule</Button>
                    </InlineStack>
                  </Box>
                  <div style={{ transform: 'translateZ(0)' }}>
                    <IndexTable
                      resourceName={{ singular: 'rule', plural: 'rules' }}
                      itemCount={rules.length}
                      headings={[
                        { title: 'Status' },
                        { title: 'Rule Name' },
                        { title: 'Description' },
                        { title: 'Actions' },
                      ]}
                      selectable={false}
                    >
                      {rules.map((rule, index) => (
                        <IndexTable.Row id={rule.id} key={rule.id} position={index}>
                          <IndexTable.Cell>
                            <Badge tone={rule.isActive ? 'success' : undefined}>{rule.isActive ? 'Active' : 'Disabled'}</Badge>
                          </IndexTable.Cell>
                          <IndexTable.Cell><Text variant="bodyMd" fontWeight="bold" as="span">{rule.name}</Text></IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text variant="bodyMd" as="span">
                              {rule.description}
                              {rule.triggerType === 'time_fringe' && ` (Flags activity outside ${rule.timeOpen || '09:00'} to ${rule.timeClose || '17:00'})`}
                              {rule.triggerType === 'manual_correction' && ` (Alert if > ${rule.quantityThreshold || 0} units)`}
                              {rule.triggerType === 'velocity' && ` (Alert if > ${rule.quantityThreshold || 5} scans in ${rule.timeOpen || 60}s)`}
                              {rule.triggerType === 'unmatched' && ` (Requires valid Shopify ID)`}
                              {rule.triggerType === 'supplier_mismatch' && ` (Alert on receiving mismatch)`}
                              {rule.triggerType === 'high_value_order' && ` (Alert > $${rule.quantityThreshold || '...'} AND > ${rule.timeOpen || '...'} units)`}
                              {rule.triggerType === 'supplier_over_receiving' && ` (Alert on supplier overage)`}
                              {rule.triggerType === 'unauthorized_return' && ` (Requires valid RMA)`}
                              {rule.triggerType === 'high_risk_address' && ` (Flags forwarders/risky ZIPs)`}
                              {rule.triggerType === 'location_violation' && ` (Enforces location constraints)`}
                            </Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <ButtonGroup>
                              <Button variant="plain" onClick={() => openEditRuleModal(rule)}>Edit</Button>
                              <Button variant="plain" tone="critical" onClick={() => setRules(r => r.filter(x => x.id !== rule.id))}>Delete</Button>
                            </ButtonGroup>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  </div>
                </Card>

                {/* Help and Handbook Section */}
                <Card>
                  <BlockStack gap="400">
                    <Text variant="headingLg" as="h2">Protection & Security Handbook</Text>
                    <Text as="p">
                      This application continuously monitors your warehouse inventory and cross-references it with live Shopify transactions. Its primary goal is to identify <strong>unaccounted inventory</strong>—instances where physical inventory is consumed or modified without matching sales data or authorization. 
                    </Text>
                    <Text as="p">
                      <strong>Understanding the Graph:</strong> The orange area is your total physical stock. The green area is the stock that has been <strong>accounted for</strong> against Shopify orders. The gap between them is your unverified inventory (click graph to zoom).
                    </Text>
                    <Text as="p">
                      By setting up rules, you tell the system exactly what behaviors indicate potential theft or operational errors.
                    </Text>
                    <Divider />
                    <div id="detailed-rules-handbook" style={{ maxHeight: '300px', overflowY: 'auto', padding: '16px', backgroundColor: 'var(--p-color-bg-surface-secondary)', borderRadius: 'var(--p-border-radius-200)' }}>
                      <BlockStack gap="400">
                        <Text variant="headingMd" as="h3">Detailed Rules Guide</Text>
                        
                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4">1. Fringe Hours Activity</Text>
                          <Text as="p"><strong>Why it's important:</strong> The majority of unaccounted inventory loss occurs when managers are not on the floor, specifically before opening shifts or after closing. This rule monitors the "fringe" hours of the day.</Text>
                          <Text as="p"><strong>Example:</strong> Your business hours are 09:00 to 17:00. You set a Fringe Hours Activity rule. If an employee logs an inventory adjustment at 18:30, the system immediately flags the action as an active alert, freezing the timestamp, product, and person involved.</Text>
                        </BlockStack>

                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4">2. Unmatched Consumption</Text>
                          <Text as="p"><strong>Why it's important:</strong> The core of this system is the integration with Shopify. If inventory leaves the warehouse, it must have an associated order ID. This rule flags any outgoing stock that bypasses the Point-of-Sale or eCommerce checkout.</Text>
                          <Text as="p"><strong>Example:</strong> 5 units of 'Premium Shield Cases' are deducted from the physical warehouse count, but no corresponding Shopify order exists in the last 24 hours. The alert is triggered so you can investigate the discrepancy.</Text>
                        </BlockStack>

                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4">3. High-Velocity Corrections</Text>
                          <Text as="p"><strong>Why it's important:</strong> Rapid, repeated adjustments to the exact same item often signal an operational error (like a worker accidentally double-scanning an item, causing a duplicate deduction).</Text>
                          <Text as="p"><strong>Example:</strong> An employee scans a barcode to drop inventory by 1, but accidentally double-taps the button. Two separate identical deductions are logged within seconds. The rule immediately catches this velocity spike and warns you of the double-scan.</Text>
                        </BlockStack>

                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4">4. Manual Correction Spike</Text>
                          <Text as="p"><strong>Why it's important:</strong> "Manual Correction Spikes" are direct edits to the inventory count, bypassing standard restocking or sales workflows. While sometimes necessary for cycle counts, large manual corrections are the easiest way to hide missing stock.</Text>
                          <Text as="p"><strong>Example:</strong> An employee uses the manual override function to change the total count of an item from 100 down to 95, stating "inventory check". If your threshold is set to 3 units, this -5 adjustment triggers an immediate alert.</Text>
                        </BlockStack>

                        <BlockStack gap="200">
                          <Text variant="headingSm" as="h4">5. Supplier Mismatch (Inbound Security)</Text>
                          <Text as="p"><strong>Why it's important:</strong> Supplier short-shipping is a silent margin killer. When receiving inventory, your staff must physically count the items and compare them to the packing slip or PO. This rule flags any discrepancies.</Text>
                          <Text as="p"><strong>Example:</strong> A packing slip indicates 10 units arrived, but the employee only physically counts 9. They enter a quantity of 9, provide the PO number, and uncheck the 'Fully Met' box. The system instantly generates an alert with the uploaded packing slip image so you can dispute the short-shipment with the supplier.</Text>
                        </BlockStack>
                      </BlockStack>
                    </div>
                  </BlockStack>
                </Card>

              </BlockStack>
            </Layout.Section>
          </Layout>
        )}

      {/* Modal for Adding/Editing Rules */}
      <Modal
        open={isRuleModalOpen}
        onClose={closeRuleModal}
        title={editingRuleId ? "Edit Security Rule" : "Create Security Rule"}
        primaryAction={{
          content: 'Save Rule',
          onAction: handleSaveRule,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: closeRuleModal,
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Rule Name"
              value={newRuleName}
              onChange={setNewRuleName}
              autoComplete="off"
            />
            <Select
              label="Trigger Condition"
              options={[
                { label: 'After-Hours or Fringe Activity', value: 'time_fringe' },
                { label: 'Manual Correction Spike', value: 'manual_correction' },
                { label: 'Unmatched Consumption (No Order ID)', value: 'unmatched' },
                { label: 'High-Velocity Corrections (Double-scans)', value: 'velocity' },
                { label: 'Supplier Mismatch (Inbound Shortage)', value: 'supplier_mismatch' },
                { label: 'Supplier Over-Receiving (Inbound Bloat)', value: 'supplier_over_receiving' },
                { label: 'Unauthorized Customer Returns (No RMA)', value: 'unauthorized_return' },
                { label: 'High-Value / Bulk Order Risk', value: 'high_value_order' },
                { label: 'High-Risk Shipping Address (Fraud/Forwarder)', value: 'high_risk_address' },
                { label: 'Location Constraint Violation', value: 'location_violation' },
              ]}
              value={newRuleTriggerType}
              onChange={setNewRuleTriggerType}
            />
            
            {newRuleTriggerType === 'time_fringe' && (
              <InlineStack gap="400">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Store Opening Time"
                    type="time"
                    value={timeOpen}
                    onChange={setTimeOpen}
                    autoComplete="off"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Store Closing Time"
                    type="time"
                    value={timeClose}
                    onChange={setTimeClose}
                    autoComplete="off"
                  />
                </div>
              </InlineStack>
            )}
            
            {newRuleTriggerType === 'manual_correction' && (
              <TextField
                label="Alert if correction quantity exceeds"
                value={quantityThreshold}
                onChange={setQuantityThreshold}
                autoComplete="off"
                type="number"
                suffix="units"
                placeholder="e.g., 5"
              />
            )}

            {newRuleTriggerType === 'velocity' && (
              <InlineStack gap="400">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Number of Adjustments"
                    value={quantityThreshold}
                    onChange={setQuantityThreshold}
                    autoComplete="off"
                    type="number"
                    suffix="scans"
                    placeholder="e.g., 2"
                    helpText="How many distinct scans trigger the alert."
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Within Time Window"
                    value={timeOpen}
                    onChange={setTimeOpen}
                    autoComplete="off"
                    type="number"
                    suffix="seconds"
                    placeholder="e.g., 60"
                    helpText="The timeframe to watch for rapid scans."
                  />
                </div>
              </InlineStack>
            )}

            {newRuleTriggerType === 'high_value_order' && (
              <InlineStack gap="400">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Alert if Order Value Exceeds"
                    value={quantityThreshold}
                    onChange={setQuantityThreshold}
                    autoComplete="off"
                    type="number"
                    prefix="$"
                    placeholder="e.g., 5000"
                    helpText="Total revenue threshold (leave blank to ignore)."
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="AND Total Order Quantity Exceeds"
                    value={timeOpen}
                    onChange={setTimeOpen}
                    autoComplete="off"
                    type="number"
                    suffix="units"
                    placeholder="e.g., 10"
                    helpText="Combined with revenue to prevent false positives."
                  />
                </div>
              </InlineStack>
            )}

            {newRuleTriggerType === 'high_risk_address' && (
              <TextField
                label="Fraud Blocklist (Addresses & ZIPs)"
                value={quantityThreshold}
                onChange={setQuantityThreshold}
                autoComplete="off"
                multiline={3}
                placeholder="e.g., 345 Birm Ave, 33166, Doral Freight"
                helpText="Comma-separate specific street addresses or ZIP codes to automatically block."
              />
            )}

            {newRuleTriggerType === 'location_violation' && (
              <TextField
                label="Protected Retail Location Names"
                value={quantityThreshold}
                onChange={setQuantityThreshold}
                autoComplete="off"
                placeholder="e.g., Downtown Store, Miami Kiosk"
                helpText="Comma-separate the exact names of the physical retail locations that should never fulfill internet orders."
              />
            )}
            
            {['high_value_order', 'supplier_over_receiving', 'unauthorized_return', 'high_risk_address', 'location_violation'].includes(newRuleTriggerType) && (
              <Box paddingBlockStart="200">
                <Checkbox
                  label={newRuleTriggerType === 'high_value_order' ? "Halt fulfillment and place order on hold" : "Pause transaction / Block staff action pending manager review"}
                  checked={haltFulfillment}
                  onChange={setHaltFulfillment}
                  helpText={dbConfig?.planType === 'premium' ? "This automated stop/hold feature is active." : "Requires Premium Subscription."}
                  disabled={dbConfig?.planType !== 'premium'}
                />
              </Box>
            )}

            <TextField
              label="Optional Notes"
              value={newRuleDescription}
              onChange={setNewRuleDescription}
              multiline={2}
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Modal for Details */}
      {selectedItem && (
        <Modal
          open={activeModal}
          onClose={toggleModal}
          title={`Inventory Details: ${selectedItem.productName}`}
          secondaryActions={[
            {
              content: 'Close',
              onAction: toggleModal,
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p" variant="bodyMd">
                {filteredPerson 
                  ? `Showing ${onlyAlerted ? 'alerted ' : ''}activity for contributor: ${filteredPerson}` 
                  : `Showing ${onlyAlerted ? 'alerted ' : 'all recent '}activity for ${selectedItem.productName}`}
              </Text>
              
              <Card padding="0">
                <DataTable
                  columnContentTypes={[
                    'text',
                    'text',
                    'text',
                    'numeric',
                    'text',
                    'text',
                  ]}
                  headings={[
                    'Person',
                    'Rule Triggered',
                    'Action',
                    'Quantity',
                    'Location',
                    'Time',
                  ]}
                  rows={modalRows}
                />
              </Card>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {/* Modal for Creating Custom Graph View */}
      <Modal
        open={isGraphViewModalOpen}
        onClose={() => setIsGraphViewModalOpen(false)}
        title="Create Custom Graph View"
        primaryAction={{
          content: 'Save View',
          onAction: handleSaveGraphView,
          disabled: !newGraphViewName || newGraphViewProducts.length === 0
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setIsGraphViewModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="View Name"
              value={newGraphViewName}
              onChange={setNewGraphViewName}
              placeholder="e.g., Razors"
              autoComplete="off"
            />
            <ChoiceList
              title="Select Products to Monitor"
              choices={productOptions.filter(o => o.value).map(o => ({
                label: o.label,
                value: o.value
              }))}
              selected={newGraphViewProducts}
              onChange={setNewGraphViewProducts}
              allowMultiple
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
      {investigateAlert && (
        <Modal
          open={!!investigateAlert}
          onClose={() => setInvestigateAlert(null)}
          title={`Investigation: ${investigateAlert.ruleTriggered}`}
          primaryAction={{
            content: 'Close',
            onAction: () => setInvestigateAlert(null),
          }}
          secondaryActions={[
            {
              content: 'Forward to Supplier',
              onAction: () => window.open(`mailto:?subject=Supplier Dispute&body=Please review the discrepancy for ${investigateAlert.productName}. Evidence attached in Shopify.`),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">Transaction Details</Text>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <Text as="p" variant="bodyMd"><strong>Staff:</strong> {investigateAlert.person}</Text>
                <Text as="p" variant="bodyMd"><strong>Time:</strong> {investigateAlert.time}</Text>
                <Text as="p" variant="bodyMd"><strong>Product:</strong> {investigateAlert.productName}</Text>
                <Text as="p" variant="bodyMd"><strong>Details:</strong> {investigateAlert.details}</Text>
              </div>

              <Divider />
              <InlineStack align="space-between">
                <Text as="h3" variant="headingMd">Evidence (Shopify Files)</Text>
                <Badge tone={investigateAlert.transactionId?.startsWith('Exception') ? "warning" : "success"}>
                  {investigateAlert.transactionId?.startsWith('Exception') ? "Draft / Missing Evidence" : "Final / Verified"}
                </Badge>
              </InlineStack>
              
              <Card background="bg-surface-secondary">
                <Box padding="400">
                  {investigateAlert.transactionId?.startsWith('Exception') ? (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" tone="critical"><strong>Missing Media Reason:</strong></Text>
                      <Text as="p" variant="bodyMd">{investigateAlert.transactionId}</Text>
                    </BlockStack>
                  ) : investigateAlert.transactionId ? (
                    <BlockStack gap="300">
                      <Text as="p" variant="bodyMd">The following media IDs have been securely stored in your Shopify Files:</Text>
                      <div style={{ padding: '12px', background: '#000', color: '#00ff00', fontFamily: 'monospace', borderRadius: '4px' }}>
                        {investigateAlert.transactionId}
                      </div>
                      <Text as="p" variant="bodySm" tone="subdued">Because these are secure admin files, you must view them directly in your Shopify Admin Settings -&#62; Files dashboard, or forward this alert to your supplier.</Text>
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">No evidence attached.</Text>
                  )}
                </Box>
              </Card>

              <Divider />
              <Text as="h3" variant="headingMd">Investigation Sharing</Text>
              <InlineStack gap="300" blockAlign="center">
                <div style={{ flex: 1 }}>
                  <Select
                    label="Share visibility with:"
                    options={[
                      { label: "Only Me (Owner)", value: "owner" },
                      { label: "Store Managers", value: "managers" },
                      { label: "All Staff", value: "all" },
                      { label: `Specific User: ${investigateAlert.person}`, value: "user" }
                    ]}
                    value={shareWith}
                    onChange={setShareWith}
                  />
                </div>
                <div style={{ marginTop: '24px' }}>
                  <Button onClick={() => setShareWith("owner")}>Update Permissions</Button>
                </div>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">By default, only the Owner can view mismatch investigations. You can grant access to managers to help resolve this dispute.</Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

export default App;
