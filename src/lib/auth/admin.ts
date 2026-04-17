type SupabaseClient = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>;

export type AdminRole = 'admin' | 'operator';

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
}

/**
 * 현재 세션의 Supabase Auth 사용자를 반환한다.
 * 인증 실패 시 null.
 */
export async function getAuthUser(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * 현재 인증된 사용자가 admin_users 테이블에 등록되어 있는지 확인한다.
 * 등록되어 있으면 AdminUser, 아니면 null.
 *
 * allowedRoles를 지정하면 해당 역할만 허용한다.
 */
export async function getAdminUser(
  supabase: SupabaseClient,
  allowedRoles?: AdminRole[]
): Promise<AdminUser | null> {
  const user = await getAuthUser(supabase);
  if (!user?.email) return null;

  let query = supabase
    .from('admin_users')
    .select('id, email, name, role')
    .eq('email', user.email)
    .eq('is_active', true);

  if (allowedRoles && allowedRoles.length > 0) {
    query = query.in('role', allowedRoles);
  }

  const { data } = await query.maybeSingle();
  if (!data) return null;

  return data as AdminUser;
}

/**
 * 관리자 인증이 필요한 API에서 사용.
 * 인증 실패 시 { error, status }를 반환하고,
 * 성공 시 { admin }을 반환한다.
 */
export async function requireAdmin(
  supabase: SupabaseClient,
  allowedRoles?: AdminRole[]
): Promise<
  | { admin: AdminUser; error?: undefined; status?: undefined }
  | { admin?: undefined; error: string; status: number }
> {
  const user = await getAuthUser(supabase);
  if (!user) {
    return { error: '인증이 필요합니다.', status: 401 };
  }

  const admin = await getAdminUser(supabase, allowedRoles);
  if (!admin) {
    return { error: '관리자 권한이 없습니다.', status: 403 };
  }

  return { admin };
}
