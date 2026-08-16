import { describe, expect, it } from 'vitest';
import { BOOKING_SEARCH_RESULTS_PATTERN, LISTING_MATCH_PATTERNS } from './patterns';
import { SITE_ADAPTERS, allMatchPatterns } from './registry';

/**
 * The manifest's patterns and the adapters' own declarations are written in two
 * places because the build cannot import DOM code. These tests are what stop
 * that duplication from drifting — a new adapter whose pages the content script
 * never runs on is a feature that silently does not exist.
 */
describe('match patterns stay in step with the adapters', () => {
  it('covers every pattern the adapters declare', () => {
    const declared = allMatchPatterns();
    for (const pattern of declared) {
      expect(LISTING_MATCH_PATTERNS, `adapter declares ${pattern}`).toContain(pattern);
    }
  });

  it('declares no pattern that no adapter asked for', () => {
    // An unexplained host permission is one a store reviewer will ask about and
    // one the user has to trust for no stated reason.
    const declared = new Set(allMatchPatterns());
    for (const pattern of LISTING_MATCH_PATTERNS) {
      expect(declared, `${pattern} belongs to no adapter`).toContain(pattern);
    }
  });

  it('every bespoke adapter contributes at least one pattern', () => {
    for (const adapter of SITE_ADAPTERS) {
      expect(adapter.matchPatterns.length, `${adapter.id} declares no pages`).toBeGreaterThan(0);
    }
  });

  it('requests no blanket host access', () => {
    // Every host pattern this module exports, so a new one cannot be added
    // without passing through here.
    for (const pattern of [...LISTING_MATCH_PATTERNS, BOOKING_SEARCH_RESULTS_PATTERN]) {
      expect(pattern).not.toBe('<all_urls>');
      expect(pattern).not.toMatch(/^\*:\/\/\*\/\*$/);
      // A pattern with no path is host-wide access; every entry should be
      // scoped to the listing or search pages we actually read.
      expect(pattern).toMatch(/\*$|\/\*/);
    }
  });
});
