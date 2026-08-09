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
    config.admin.createToken = 'different';
    config.srvpro.apiKey = 'key';
    expect(() => validateStartupSecurity()).toThrow(/insecure admin token/);
  });

  it('rejects an empty srvpro API key', () => {
    config.server.allowInsecureDefaults = false;
    config.admin.superToken = 'unique-super';
    config.admin.createToken = 'unique-create';
    config.srvpro.apiKey = '';
    expect(() => validateStartupSecurity()).toThrow(/srvpro\.api_key/);
  });
});
