export const USERNAME_RULE_ERROR =
	"用户名须为1至64个字符，以字母或数字开头，仅可包含字母、数字、组合音标、下划线、点和连字符";

// 仅约束新账号，不改写存量标识或登录输入；输出到 HTML 时仍须独立转义。
export function isValidNewUsername(username: string): boolean {
	return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_.-]{0,63}$/u.test(username);
}
