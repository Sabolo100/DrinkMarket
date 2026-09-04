'use client';

/**
 * A státuszsáv és a lista frissítésének összekötése.
 *
 * Amikor a futás befejeződik, a mögötte lévő borászatlista is elavult: a
 * „N terméken felismerve" oszlop és a „még nem alkalmazott" számláló is
 * megváltozott. A `router.refresh()` a szerveroldali adatot tölti újra,
 * anélkül, hogy a felhasználó bármit tenne.
 */
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { ApplyStatus } from './ApplyStatus';

export function ApplyStatusBar() {
  const router = useRouter();
  const onFinished = useCallback(() => { router.refresh(); }, [router]);
  return <ApplyStatus onFinished={onFinished} />;
}
