export interface LoginVerificationSettings {
  enabled: boolean;
  siteKey: string;
}

export async function getLoginVerification(db): Promise<LoginVerificationSettings> {
  const { results } = await db.prepare(
    "SELECT setting_value FROM site_settings WHERE setting_key = 'login_verification'",
  ).all();
  return results[0] ? JSON.parse(results[0].setting_value) : { enabled: false, siteKey: '' };
}

export async function saveLoginVerification(db, settings: LoginVerificationSettings) {
  // 只保存管理员配置，不记录登录失败或验证次数，避免为风控增加逐次写入。
  await db.prepare(`INSERT INTO site_settings (setting_key, setting_value, updated_at)
    VALUES ('login_verification', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(settings)).run();
  return settings;
}
