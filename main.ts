// main.ts — Вебхук для ЮMoney с REST API Firestore

// Функция для генерации JWT для авторизации в Google APIs
async function generateJWT(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://firestore.googleapis.com/",
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj: any) => btoa(JSON.stringify(obj));
  const toBase64Url = (str: string) =>
    str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const headerB64 = toBase64Url(encode(header));
  const payloadB64 = toBase64Url(encode(payload));

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    new TextEncoder().encode(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  const signatureB64 = toBase64Url(btoa(String.fromCharCode(...new Uint8Array(signature))));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// Получение access token из JWT
async function getAccessToken(serviceAccount: any): Promise<string> {
  const jwt = await generateJWT(serviceAccount);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  return data.access_token;
}

// Обновление баланса через REST API
async function updateBalance(projectId: string, uid: string, amount: number, accessToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;

  // Получаем текущий документ
  const getResp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let docData = {};
  let currentBalance = 0;
  let history: any[] = [];
  if (getResp.status === 200) {
    const doc = await getResp.json();
    docData = doc.fields || {};
    const balanceField = docData.balance?.integerValue || "0";
    currentBalance = parseInt(balanceField);
    const historyField = docData.history?.arrayValue?.values || [];
    history = historyField.map((v: any) => {
      const map = v.mapValue?.fields;
      return {
        timestamp: map?.timestamp?.timestampValue,
        amount: parseInt(map?.amount?.integerValue),
        description: map?.description?.stringValue,
      };
    });
  } else {
    // Документ не существует, создадим новый
  }

  const newBalance = currentBalance + amount;
  history.push({
    timestamp: new Date().toISOString(),
    amount: amount,
    description: `Пополнение через ЮMoney (операция ${operation_id})`,
  });

  // Обновляем документ (патч)
  const patchData = {
    fields: {
      balance: { integerValue: newBalance.toString() },
      history: {
        arrayValue: {
          values: history.map((h: any) => ({
            mapValue: {
              fields: {
                timestamp: { timestampValue: h.timestamp },
                amount: { integerValue: h.amount.toString() },
                description: { stringValue: h.description },
              },
            },
          })),
        },
      },
    },
  };
  const patchResp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchData),
  });
  if (!patchResp.ok) {
    const err = await patchResp.text();
    throw new Error(`Firestore update failed: ${err}`);
  }
}

// --- Обработчик HTTP ---
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/webhook") return new Response("Not Found", { status: 404 });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Переменные окружения
  const serviceAccountJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  const yoomoneySecret = Deno.env.get("YOOMONEY_SECRET");
  if (!serviceAccountJson || !yoomoneySecret) {
    console.error("Missing env vars");
    return new Response("Server configuration error", { status: 500 });
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  // Проверяем подпись ЮMoney
  const formData = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of formData.entries()) params[k] = v.toString();

  // Проверка подписи (SHA-1)
  const sortedKeys = Object.keys(params).filter(k => k !== "signature").sort();
  let str = "";
  for (const k of sortedKeys) str += `${k}=${params[k]}&`;
  str += yoomoneySecret;
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hashHex !== params.signature) {
    console.error("Invalid signature");
    return new Response("Invalid signature", { status: 400 });
  }

  const uid = params.label;
  const amountStr = params.amount;
  const operation_id = params.operation_id || "unknown";
  if (!uid) return new Response("Missing label", { status: 400 });
  const amount = parseFloat(amountStr.replace(",", "."));
  if (isNaN(amount) || amount <= 0) return new Response("Invalid amount", { status: 400 });

  // Получаем access token
  const token = await getAccessToken(serviceAccount);
  const projectId = serviceAccount.project_id;

  try {
    await updateBalance(projectId, uid, amount, token);
    console.log(`User ${uid} topped up ${amount}₽`);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Transaction error", { status: 500 });
  }
}

Deno.serve(handleRequest);
