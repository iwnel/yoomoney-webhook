// main.ts
import { initializeApp, cert } from "npm:firebase-admin/app";
import { getFirestore } from "npm:firebase-admin/firestore";

// ---- 1. Инициализация Firebase Admin из переменной окружения ----
const serviceAccount = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT") || "{}");
if (!serviceAccount.project_id) {
  console.error("FIREBASE_SERVICE_ACCOUNT не задана");
  Deno.exit(1);
}

initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();

// ---- 2. Проверка подписи ЮMoney (SHA-1) ----
async function checkSignature(secret: string, params: Record<string, string>): Promise<boolean> {
  // Сортируем ключи, исключая 'signature'
  const sortedKeys = Object.keys(params)
    .filter(key => key !== 'signature')
    .sort();

  let string = "";
  for (const key of sortedKeys) {
    string += `${key}=${params[key]}&`;
  }
  string += secret;

  // Вычисляем SHA-1 через Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(string);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex === params.signature;
}

// ---- 3. Обработчик HTTP-запросов ----
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Принимаем только POST на /webhook
  if (url.pathname !== "/webhook") {
    return new Response("Not Found", { status: 404 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Получаем секрет ЮMoney из переменной окружения
  const yoomoneySecret = Deno.env.get("YOOMONEY_SECRET");
  if (!yoomoneySecret) {
    console.error("YOOMONEY_SECRET не задана");
    return new Response("Server configuration error", { status: 500 });
  }

  // Парсим тело запроса (application/x-www-form-urlencoded)
  const formData = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    params[key] = value.toString();
  }

  // Проверяем подпись
  const isValid = await checkSignature(yoomoneySecret, params);
  if (!isValid) {
    console.error("Неверная подпись");
    return new Response("Invalid signature", { status: 400 });
  }

  // Извлекаем данные
  const label = params.label;      // это будет UID пользователя
  const amount = params.amount;    // сумма
  const operation_id = params.operation_id || "unknown";

  if (!label) {
    console.error("Отсутствует label (UID)");
    return new Response("Missing label", { status: 400 });
  }

  // Преобразуем сумму (может быть с запятой)
  const sum = parseFloat(amount.replace(",", "."));
  if (isNaN(sum) || sum <= 0) {
    console.error("Некорректная сумма");
    return new Response("Invalid amount", { status: 400 });
  }

  // ---- 4. Обновляем баланс в Firestore ----
  try {
    const userRef = db.collection("users").doc(label);
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(userRef);
      if (!doc.exists) {
        // Если пользователь ещё не создан, создаём документ
        transaction.set(userRef, {
          balance: 0,
          servers: [],
          history: []
        });
      }
      const data = doc.data() || { balance: 0 };
      const newBalance = (data.balance || 0) + sum;
      const history = data.history || [];
      history.push({
        timestamp: new Date(),
        amount: sum,
        description: `Пополнение через ЮMoney (операция ${operation_id})`
      });
      transaction.update(userRef, {
        balance: newBalance,
        history: history
      });
    });

    console.log(`Пользователь ${label} пополнил баланс на ${sum} ₽`);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Ошибка обновления баланса:", error);
    return new Response("Transaction error", { status: 500 });
  }
}

// ---- 5. Запуск сервера ----
Deno.serve(handleRequest);