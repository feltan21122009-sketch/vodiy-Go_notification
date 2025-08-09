const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');
const webPush = require('web-push');
const cors = require('cors');
require("dotenv").config()
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(bodyParser.json());

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
}

webPush.setVapidDetails(
  'mailto:abdulloh50007@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Подписки в памяти (но не храним старые)
let subscriptions = [];

const allowedOrigins = [
  'https://9000-firebase-studio-1752840810300.cluster-ubrd2huk7jh6otbgyei4h62ope.cloudworkstations.dev',
  'https://vodiy-go.vercel.app'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Разрешить без Origin (например, Postman)
    const cleanOrigin = origin.replace(/\/$/, ''); // убираем / в конце
    if (allowedOrigins.includes(cleanOrigin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));


// Сохраняем подписку только пока жив сервер
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  subscriptions = [subscription]; // перезаписываем, храним только последнюю
  res.status(201).json({});
});

let isInitialLoad = true;

// Следим за изменениями в Firestore
db.collection('userRegistrationRequests').orderBy('createdAt', 'desc').limit(1).onSnapshot(snapshot => {
  if (isInitialLoad) {
    isInitialLoad = false;
    return; // пропустить первую загрузку старых
  }

  snapshot.docChanges().forEach(change => {
    if (change.type === 'added') {
      const data = change.doc.data();
      console.log('Новая заявка:', data);

      const payload = JSON.stringify({
        title: 'Новая заявка на регистрацию пользователя',
        body: `От: ${data.phone}\nКод: ${data.verificationCode}`,
        icon: './icon.png'
      });

      // Отправляем только по последней подписке
      subscriptions.forEach(sub => {
        webPush.sendNotification(sub, payload).catch(err => console.error(err));
      });
    }
  });
});

app.get('/vapidPublicKey', (req, res) => {
  res.send(vapidKeys.publicKey);
});

app.listen(3000, () => console.log('Сервер запущен на 3000'));
