// test.ts
// Отправляем тестовый запрос на вебхук

const webhookUrl = "https://yoomoney-webhook-5z7ps5ymg8b5.zephyrnode.deno.net/webhook";

// Параметры, которые отправит ЮMoney
const params = {
  label: "oRP6QgLC2gUFePszS6SACCpReb92",   // замените на реальный UID пользователя из Firestore
  amount: "100.00",
  operation_id: "test_op_001",
  datetime: "2025-01-01T12:00:00Z",
};

// Секретный ключ (возьмите из переменной окружения или укажите вручную)
const secret = Deno.env.get("YOOMONEY_SECRET") || "ваш_секретный_ключ";

// Генерируем подпись (как в вебхуке)
function generateSignature(secret: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).filter(k => k !== "signature").sort();
  let str = "";
  for (const k of sortedKeys) {
    str += `${k}=${params[k]}&`;
  }
  str += secret;
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Создаём form-data (как это делает ЮMoney)
const formData = new URLSearchParams();
for (const [key, value] of Object.entries(params)) {
  formData.append(key, value);
}
const signature = await generateSignature(secret, params);
formData.append("signature", signature);

// Отправляем POST-запрос
const response = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: formData.toString(),
});

console.log("Status:", response.status);
console.log("Response:", await response.text());
