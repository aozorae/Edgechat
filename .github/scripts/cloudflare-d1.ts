type D1Row = Record<string, unknown>;

export function createD1Query(env = process.env) {
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "EDGECHAT_D1_DATABASE_ID"]) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  return async (sql: string, params: unknown[] = []): Promise<D1Row[]> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.EDGECHAT_D1_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      },
    );
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      // 查询可能包含密码哈希，不把上游响应或 SQL 原文带入公开部署日志。
      throw new Error(`Cloudflare D1 query failed with ${response.status}`);
    }
    return payload.result[0].results;
  };
}
