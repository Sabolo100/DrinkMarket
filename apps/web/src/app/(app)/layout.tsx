import { Shell } from '@/components/Shell';
import { apiSafe, requireSession } from '@/lib/api';
import type { AnchorShop } from '@/components/AnchorShopPicker';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const [shops, summary] = await Promise.all([
    apiSafe<{ items: AnchorShop[] }>('/shops', { items: [] }),
    apiSafe<{ general: Record<string, number> | null }>('/dashboard/summary', { general: null }),
  ]);

  const g = summary.general ?? {};
  const counts = {
    reviews: Number(g['reviews_open'] ?? 0),
    unmatched: 0,
    alerts: Number(g['shops_unhealthy'] ?? 0) + Number(g['alerts_open'] ?? 0),
    unclustered: Number(g['listings_unclustered'] ?? 0),
  };

  return (
    <Shell
      user={session.user}
      csrfToken={session.csrfToken}
      shops={shops.items.filter((s) => s.active !== false)}
      counts={counts}
    >
      {children}
    </Shell>
  );
}
