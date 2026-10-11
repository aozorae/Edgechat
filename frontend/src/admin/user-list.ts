type UserIdentity = { displayName: string; username: string };

// 后端按页返回账号；仅筛选当前页，避免把局部结果误称为全站搜索。
export function filterAdminUsers<T extends UserIdentity>(users: T[], query: string): T[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return users;
  return users.filter((user) => `${user.displayName}\n@${user.username}`.toLowerCase().includes(keyword));
}
