/**
 * Mi bizonyitja, hogy egy termek MAR NINCS MEG?
 *
 * Az `unavailable` allapot ket, gyokeresen kulonbozo dolgot takart:
 *
 *   - a BOLT valaszolt, es azt mondta, hogy nincs meg  -> bizonyitek
 *   - MI nem tudtuk megkerdezni                        -> nem bizonyit semmit
 *
 * A ketto ugyanabba az agba futott. A valos rendszerben ez merheto kart
 * okozott: egy arfrissites, ami EGYETLEN HTTP kerest sem kuldott ki
 * (`requests_attempted = 0`, `http_status_counts = {}`), 1114 terméket
 * jelolt eltuntnek. Egy masik 497-et. Mivel a publikalas `active` listinget
 * kovetel, ezzel 2664 igazolt parositasbol 1779 esett ki a piaci oldalrol.
 *
 * Ez ugyanaz a hibaosztaly, mint amikor a szallitasi kuszobot arnak vettuk:
 * a bizonyitek HIANYABOL lett bizonyitek.
 */
import { describe, it, expect } from 'vitest';
import { isDisappearanceEvidence } from '../../apps/worker/src/lib/persist.js';

const withCodes = (...codes: string[]) => ({
  diagnostics: { errors: codes.map((code) => ({ code, message: code })) },
});

describe('a bolt valasza bizonyitek', () => {
  it('HTTP 404 -> a termek tenyleg nincs meg', () => {
    expect(isDisappearanceEvidence(withCodes('HTTP_404'))).toBe(true);
  });

  it('HTTP 410 (Gone) -> szinten', () => {
    expect(isDisappearanceEvidence(withCodes('HTTP_410'))).toBe(true);
  });

  it('soft 404 -> az oldal betoltodott, es 404-nek latszik', () => {
    expect(isDisappearanceEvidence(withCodes('SOFT_404'))).toBe(true);
  });

  it('kisbetus kod is szamit', () => {
    expect(isDisappearanceEvidence(withCodes('http_404'))).toBe(true);
  });
});

describe('a mi hibank NEM bizonyitek', () => {
  it('FETCH_FAILED -> meg sem kerdeztuk', () => {
    // Ez az az ag, ami a valos karokat okozta: DNS, TLS, SSRF-or, robots
    // es halozati hiba egyarant ide fut.
    expect(isDisappearanceEvidence(withCodes('FETCH_FAILED'))).toBe(false);
  });

  it('ures hibalista -> nincs mire alapozni', () => {
    expect(isDisappearanceEvidence({ diagnostics: { errors: [] } })).toBe(false);
  });

  it('hianyzo diagnosztika -> nincs mire alapozni', () => {
    expect(isDisappearanceEvidence({})).toBe(false);
    expect(isDisappearanceEvidence({ diagnostics: null })).toBe(false);
  });

  it('ISMERETLEN kod -> alapertelmezesben NEM bizonyitek', () => {
    // Aki uj agat vezet be, annak kifejezetten ki kell mondania, hogy az
    // bizonyitek. A hallgatas nem jelenthet igent.
    expect(isDisappearanceEvidence(withCodes('VALAMI_UJ_HIBA'))).toBe(false);
  });

  it('rate limit es blokkolas sem bizonyitek', () => {
    expect(isDisappearanceEvidence(withCodes('RATE_LIMITED'))).toBe(false);
    expect(isDisappearanceEvidence(withCodes('CHALLENGE'))).toBe(false);
  });
});

describe('vegyes eset', () => {
  it('ha barmelyik hibakod 404, az bizonyitek', () => {
    expect(isDisappearanceEvidence(withCodes('FETCH_FAILED', 'HTTP_404'))).toBe(true);
  });
});
