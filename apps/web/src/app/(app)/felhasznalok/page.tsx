import { PageHead } from '@/components/Shell';
import { apiSafe, requireSession } from '@/lib/api';
import { UserAdmin, type AdminUser } from './UserAdmin';

export const dynamic = 'force-dynamic';

/**
 * Felhasználók kezelése.
 *
 * A rendszer zárt: nyilvános regisztráció nincs, a hozzáférést adminisztrátor
 * adja ki MEGHÍVÓVAL. A meghívott maga állítja be a jelszavát — az admin
 * soha nem ismeri, és nem is kell továbbítania.
 *
 * Az API ezt eddig is tudta, de felület nem volt hozzá, és a meghívó link egy
 * nem létező oldalra mutatott.
 */
export default async function UsersPage() {
  const session = await requireSession();

  if (session.user.role !== 'admin') {
    return (
      <>
        <PageHead title="Felhasználók" />
        <div className="callout">
          <p style={{ margin: 0 }}>A felhasználók kezeléséhez adminisztrátori jogosultság kell.</p>
        </div>
      </>
    );
  }

  const data = await apiSafe<{ items: AdminUser[] }>('/users', { items: [] });

  return (
    <>
      <PageHead
        title="Felhasználók"
        lede="Meghívásos hozzáférés. A meghívott a kapott linken maga állítja be a jelszavát."
      />
      <UserAdmin users={data.items} csrfToken={session.csrfToken} selfId={session.user.id} />
    </>
  );
}
