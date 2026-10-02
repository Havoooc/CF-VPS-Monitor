// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { cfsmGet } from "../http";
import { clearJwtToken, getJwtToken, resetApiBaseCache, validateApiBase } from "../config";
beforeEach(() => {
  localStorage.clear(); document.head.innerHTML = '<meta name="apiBase" content="https://a.example,https://b.example">';
  resetApiBaseCache();
});
afterEach(() => vi.unstubAllGlobals());
it("isolates credentials and a secondary backend 401", async () => {
  localStorage.setItem("jwt_token", "page-secret");
  localStorage.setItem("jwt_token:https://a.example", "a-secret");
  localStorage.setItem("jwt_token:https://b.example", "b-secret");
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_: unknown, init: RequestInit) => {
    calls.push(init); return new Response('{}', {status: 401});
  }));
  await expect(cfsmGet('/api/config', z.object({}), {base:'https://b.example'})).rejects.toThrow();
  expect((calls[0]!.headers as Record<string,string>).Authorization).toBe('Bearer b-secret');
  expect(getJwtToken('https://a.example')).toBe('a-secret');
  expect(getJwtToken('https://b.example')).toBe('');
  expect(localStorage.getItem('jwt_token')).toBe('page-secret');
  clearJwtToken('https://a.example');
});
it("rejects insecure and unconfigured destinations", () => {
  expect(() => validateApiBase('http://a.example')).toThrow();
  expect(() => validateApiBase('https://untrusted.example')).toThrow();
});
it("does not reuse a page credential for a cross-origin backend", () => {
  localStorage.setItem('jwt_token','page-secret');
  expect(getJwtToken('https://a.example')).toBe('');
});
