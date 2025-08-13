const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');
const webPush = require('web-push');
const cors = require('cors');
require('dotenv').config();

// === Firebase service account (оборачиваем в try/catch для читаемости ошибок) ===
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (err) {
  console.error('Ошибка парсинга FIREBASE_SERVICE_ACCOUNT_KEY. Проверь .env', err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// === Express + body parser + CORS ===
const app = express();
app.use(bodyParser.json());

const allowedOrigins = [
  'https://9000-firebase-studio-1752840810300.cluster-ubrd2huk7jh6otbgyei4h62ope.cloudworkstations.dev',
  'https://vodiy-go.vercel.app'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const cleanOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(cleanOrigin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// === VAPID (web-push) ===
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};
webPush.setVapidDetails('mailto:abdulloh50007@gmail.com', vapidKeys.publicKey, vapidKeys.privateKey);

// === Подписки в памяти ===
let adminSubscription = null;

// driverSubscriptions: Map<driverId, Map<encodedEndpoint, subscriptionObject>>
const driverSubscriptions = new Map();

// === Endpoints подписки ===

// Админ подписывается (как раньше)
app.post('/subscribe-admin', (req, res) => {
  adminSubscription = req.body;
  console.log('Admin subscribed');
  res.status(201).json({});
});

// Водитель подписывается: { driverId, subscription }
app.post('/subscribe-driver', (req, res) => {
  const { driverId, subscription } = req.body;
  if (!driverId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'driverId и subscription.endpoint обязательны' });
  }

  const encodedEndpoint = encodeURIComponent(subscription.endpoint);
  let map = driverSubscriptions.get(driverId);
  if (!map) {
    map = new Map();
    driverSubscriptions.set(driverId, map);
  }
  map.set(encodedEndpoint, subscription);
  console.log(`Driver ${driverId} subscribed: ${subscription.endpoint}`);
  res.status(201).json({});
});

// Публичный VAPID ключ
app.get('/vapidPublicKey', (req, res) => res.send(vapidKeys.publicKey));

// === Помощник: отправка пуша водителю (in-memory) ===
async function sendPushToDriverInMemory(driverId, payloadObj) {
  const map = driverSubscriptions.get(driverId);
  if (!map || map.size === 0) {
    console.log('Нет подписок в памяти для водителя', driverId);
    return;
  }

  const payload = JSON.stringify(payloadObj);
  const removals = []; // список endpoint-ов для удаления

  await Promise.all(Array.from(map.entries()).map(async ([encodedEndpoint, subscription]) => {
    try {
      await webPush.sendNotification(subscription, payload, { TTL: 60 });
      console.log(`Push sent to driver ${driverId} (${decodeURIComponent(encodedEndpoint)})`);
    } catch (err) {
      console.error(`Push error for driver ${driverId}:`, err.statusCode || err);
      // Если подписка недействительна — удаляем её из памяти
      if (err.statusCode === 410 || err.statusCode === 404) {
        removals.push(encodedEndpoint);
      }
    }
  }));

  // удалить просроченные подписки
  if (removals.length > 0) {
    const mapNow = driverSubscriptions.get(driverId);
    if (mapNow) {
      removals.forEach(e => mapNow.delete(e));
      if (mapNow.size === 0) driverSubscriptions.delete(driverId);
      console.log('Removed expired subscriptions for driver', driverId, removals.length);
    }
  }
}

// === Наблюдатели Firestore ===
// 1) Наблюдаем userRegistrationRequests — пуш админу (как было)
let isInitialLoadAdmin = true;
db.collection('userRegistrationRequests')
  .orderBy('createdAt', 'desc')
  .limit(1)
  .onSnapshot(snapshot => {
    if (isInitialLoadAdmin) { isInitialLoadAdmin = false; return; }
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added' && adminSubscription) {
        const data = change.doc.data();
        const payload = {
          title: 'Новая заявка на регистрацию пользователя',
          body: `От: ${data.phone}\nКод: ${data.verificationCode}`,
          icon: './icon.png',
          data: { url: '/admin', requestId: change.doc.id, }
        };
        webPush.sendNotification(adminSubscription, JSON.stringify(payload)).catch(err => console.error('admin push error:', err));
      }
    });
  });

// 2) Наблюдаем orders — для каждого нового order находим ride -> driverId -> отправляем водителю
let isInitialLoadOrders = true;
db.collection('orders')
  .orderBy('createdAt', 'desc')
  .limit(1)
  .onSnapshot(snapshot => {
    if (isInitialLoadOrders) { isInitialLoadOrders = false; return; }
    snapshot.docChanges().forEach(async change => {
      if (change.type !== 'added') return;

      try {
        const order = change.doc.data();
        console.log('Новый order:', order);

        if (!order.rideId) {
          console.log('Order без rideId — пуш не отправляем');
          return;
        }

        // Находим ride
        const rideDoc = await db.collection('rides').doc(order.rideId).get();
        if (!rideDoc.exists) {
          console.log('Ride не найден для rideId:', order.rideId);
          return;
        }
        const ride = rideDoc.data();
        const driverId = ride.driverId || (ride.driver && (ride.driver.id || ride.driver.uid));
        if (!driverId) {
          console.log('В ride нет driverId:', order.rideId);
          return;
        }

        // payload включая clientName/clientPhone/rideId/orderId
        const payload = {
          title: 'Новый заказ',
          body: `Клиент: ${order.clientName || '-'} \nТел: ${order.clientPhone || '-'}`,
          data: { orderId: change.doc.id, rideId: order.rideId, url: '/driver/my-orders', },
          icon: './driver-png.png',
          badge: './driver-badge.png'
        };

        // Отправляем водителю (in-memory)
        await sendPushToDriverInMemory(driverId, payload);

      } catch (err) {
        console.error('Ошибка при обработке order:', err);
      }
    });
  });

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер пушей запущен на ${PORT}`));
