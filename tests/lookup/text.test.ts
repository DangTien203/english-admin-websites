import { decodeHtmlEntities, uniqueLower } from '../../services/upstream/text';

describe('decodeHtmlEntities', () => {
  it('decodes common named and numeric entities', () => {
    expect(decodeHtmlEntities('It&#39;s &quot;ok&quot; &amp; &lt;b&gt;')).toBe('It\'s "ok" & <b>');
    expect(decodeHtmlEntities('&#x27;hi&#x27; &apos;there&apos;')).toBe("'hi' 'there'");
  });

  it('decodes in a single pass (no double decoding)', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;#39;')).toBe('&#39;');
  });

  it('leaves unknown, malformed and out-of-range entities alone', () => {
    expect(decodeHtmlEntities('&foo; &#0; &#1114112; &#xD800; AT&T &')).toBe('&foo; &#0; &#1114112; &#xD800; AT&T &');
  });

  it('is a no-op without ampersands', () => {
    expect(decodeHtmlEntities('xin chào')).toBe('xin chào');
  });
});

describe('uniqueLower', () => {
  it('lowercases, trims, de-duplicates and ignores non-strings', () => {
    expect(uniqueLower([' Big ', 'big', 'LARGE', '', 3, null, 'large'])).toEqual(['big', 'large']);
  });
});
