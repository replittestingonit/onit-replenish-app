const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const shop = 'onit-demo.myshopify.com';

  console.log('Seeding database for shop:', shop);

  // Clear existing
  await prisma.triggeredAlert.deleteMany();
  await prisma.inventoryEvent.deleteMany();
  await prisma.securityRule.deleteMany();
  await prisma.appConfiguration.deleteMany();

  // Create Config
  await prisma.appConfiguration.create({
    data: {
      shop,
      businessStart: '09:00',
      businessEnd: '17:00',
      emailAlertsEnabled: true
    }
  });

  // Create Rules
  const r1 = await prisma.securityRule.create({ data: { shop, name: 'Fringe Hours Activity', description: 'Monitors early/late shifts', triggerType: 'time_fringe', timeOpen: '09:00', timeClose: '17:00' }});
  const r2 = await prisma.securityRule.create({ data: { shop, name: 'Unmatched Consumption', description: 'Detects unaccounted inventory', triggerType: 'unmatched' }});
  const r3 = await prisma.securityRule.create({ data: { shop, name: 'High-Velocity Outflow', description: 'Detects mass withdrawals', triggerType: 'velocity', quantityThreshold: '5' }});
  const r4 = await prisma.securityRule.create({ data: { shop, name: 'Manual Correction Spike', description: 'Monitors manual adjustments', triggerType: 'manual_correction', quantityThreshold: '3' }});

  // Create Events
  const events = [];
  const now = new Date();
  
  for(let i=0; i<30; i++) {
    const time = new Date(now.getTime() - (i * 3600000)); // Past 30 hours
    events.push({
      shop,
      time,
      inventoryItemId: '4001',
      available: 1200 - (i * 5),
      reason: i % 3 === 0 ? 'corrected inventory' : 'store sales',
      transactionId: i % 3 === 0 ? null : '#SHP-900' + i,
      isProtected: i % 5 === 0
    });
  }
  
  await prisma.inventoryEvent.createMany({ data: events });

  // Create Alerts
  await prisma.triggeredAlert.create({
    data: {
      shop,
      ruleId: r4.id,
      person: 'Sue',
      productName: 'Premium Shield Cases',
      details: 'Corrected inventory (removed) by 1 unit.',
      status: 'active',
      time: new Date(now.getTime() - 3600000)
    }
  });

  console.log('Seeding complete.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
