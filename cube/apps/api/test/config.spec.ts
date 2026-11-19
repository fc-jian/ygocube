import { config, validateStartupSecurity } from '../src/config';

describe('startup security validation', () => {
  const original = JSON.parse(JSON.stringify(config));

  afterEach(() => {
    Object.assign(config.admin, original.admin);
    Object.assign(config.srvpro, original.srvpro);
    Object.assign(config.server, original.server);
  });

  it('rejects placeholder credentials by default', () => {
    config.server.allowInsecureDefaults = false;
    config.admin.superToken = 'change-me-super-token';
    config.srvpro.apiKey = 'key';
    expect(() => validateStartupSecurity()).toThrow(/insecure admin token/);
  });

  it('rejects an empty srvpro API key', () => {
    config.server.allowInsecureDefaults = false;
    config.admin.superToken = 'unique-super';
    config.srvpro.apiKey = '';
    expect(() => validateStartupSecurity()).toThrow(/srvpro\.api_key/);
  });

  it('still validates ports and exact CORS origins when insecure dev tokens are allowed', () => {
    config.server.allowInsecureDefaults = true;
    config.admin.superToken = 'change-me-super-token';
    config.srvpro.apiKey = 'key';
    config.server.port = 0;
    expect(() => validateStartupSecurity()).toThrow(/server\.port/);
    config.server.port = original.server.port;
    config.server.allowedOrigins = ['https://example.com/path'];
    expect(() => validateStartupSecurity()).toThrow(/allowed_origins/);
    config.server.allowedOrigins = ['https://example.com'];
    expect(() => validateStartupSecurity()).not.toThrow();
  });
});
