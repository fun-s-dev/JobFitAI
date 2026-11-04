import { describe, it, expect } from 'vitest';
import { routes } from '../src/app.routes';

describe('route table', () => {
  it('has no duplicate paths (a duplicated /verify path used to be dead code)', () => {
    const paths = routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('serves each page on exactly one canonical path', () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/login', '/register', '/', '/interview/:interviewId', '/interview/:interviewId/verify'])
    );
  });

  it('sends unknown URLs home instead of rendering a blank page', () => {
    const catchAll = routes.find((r) => r.path === '*');
    expect(catchAll).toBeDefined();
    expect(catchAll.element.props.to).toBe('/');
    expect(catchAll.element.props.replace).toBe(true);
  });
});
