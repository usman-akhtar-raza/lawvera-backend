import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('Health endpoint', () => {
  it('returns service health payload', () => {
    const controller = new AppController(new AppService());
    const result = controller.health();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});
