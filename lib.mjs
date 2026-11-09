const API = 'https://api.bot.qq.com';

let cache = { token: null, exp: 0 };

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}，请在 .env 中填写（--env-file 加载）`);
  return v;
}

export async function getToken(force = false) {
  const now = Date.now();
  if (!force && cache.token && now < cache.exp - 60_000) return cache.token;

  const r = await fetch(`${API}/app/getAppAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: need('QQ_APP_ID'), clientSecret: need('QQ_APP_SECRET') }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`获取 access_token 失败: ${JSON.stringify(j)}`);

  cache = { token: j.access_token, exp: now + Number(j.expires_in) * 1000 };
  console.log(`[token] ok, expires_in=${j.expires_in}s`);
  return cache.token;
}

export async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  headers.Authorization = `QQBot ${await getToken()}`;

  const r = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, traceId: r.headers.get('x-tps-trace-id'), data };
}

export function show(label, res) {
  const { status, traceId, data } = res;
  const code = data && typeof data === 'object' ? (data.err_code ?? data.code) : undefined;
  let verdict = 'OK';
  if (status === 401) verdict = '认证失败';
  else if (code === 11253) verdict = '无权限（白名单接口，需申请）';
  else if (code === 11265) verdict = '机器人已被封禁';
  else if (code) verdict = `业务错误 ${code}`;

  console.log(`\n--- ${label} ---`);
  console.log(`HTTP ${status}  ${verdict}${traceId ? `  trace=${traceId}` : ''}`);
  console.log(JSON.stringify(data, null, 2));
  return { code, verdict, data };
}
