import { describe, expect, it } from 'vitest';
import { coveredByBuiltIn, originPatternFor, parseGrantHost } from './sitegrants';

describe('parseGrantHost', () => {
  it.each([
    ['premierinn.com', 'premierinn.com'],
    ['www.premierinn.com', 'premierinn.com'],
    ['https://www.premierinn.com/gb/en/hotels/x.html', 'premierinn.com'],
    ['http://hotels.example.co.uk', 'hotels.example.co.uk'],
    ['  agoda.com  ', 'agoda.com'],
    ['premierinn.com:8443', 'premierinn.com'],
    ['192.168.1.10', '192.168.1.10'],
  ])('%s → %s', (input, host) => {
    expect(parseGrantHost(input)).toBe(host);
  });

  it('punycodes an internationalised domain the way the URL bar would', () => {
    expect(parseGrantHost('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it.each([
    [''],
    ['   '],
    ['not a domain'],
    ['localhost'], // no dot: an intranet name, not a listing site
    ['ftp://example.com'],
    ['javascript:alert(1)'],
    ['chrome://extensions'],
    ['///'],
  ])('rejects %j', (input) => {
    expect(parseGrantHost(input)).toBeNull();
  });
});

describe('originPatternFor', () => {
  it('wildcards subdomains for a domain', () => {
    expect(originPatternFor('premierinn.com')).toBe('*://*.premierinn.com/*');
  });

  it('matches an IP literal exactly — a subdomain wildcard on an IP is invalid', () => {
    expect(originPatternFor('192.168.1.10')).toBe('*://192.168.1.10/*');
  });
});

describe('coveredByBuiltIn', () => {
  it.each([
    ['booking.com'],
    ['secure.booking.com'], // manifest's *.booking.com already reaches it
    ['airbnb.com'],
    ['airbnb.co.uk'],
    ['fr.airbnb.fr'],
  ])('%s is already covered by the manifest', (host) => {
    expect(coveredByBuiltIn(host)).toBe(true);
  });

  it.each([
    ['premierinn.com'],
    ['notbooking.com'], // suffix of the name, not a subdomain of the domain
    ['booking.com.evil.example'],
    ['agoda.com'],
  ])('%s is not covered', (host) => {
    expect(coveredByBuiltIn(host)).toBe(false);
  });
});
