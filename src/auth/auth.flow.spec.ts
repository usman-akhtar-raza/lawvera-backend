import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserRole } from '../common/enums/role.enum';

describe('Auth flow', () => {
  const authServiceMock = {
    registerClient: jest.fn(),
    registerLawyer: jest.fn(),
    login: jest.fn(),
    refreshTokens: jest.fn(),
    getProfile: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handles register, login, refresh, and me paths', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
      ],
    }).compile();

    const controller = moduleRef.get(AuthController);

    const user = {
      _id: 'u1',
      name: 'Client User',
      email: 'client@example.com',
      role: UserRole.CLIENT,
    };
    const tokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    };

    authServiceMock.registerClient.mockResolvedValue({ user, tokens });
    authServiceMock.login.mockResolvedValue({ user, tokens });
    authServiceMock.refreshTokens.mockResolvedValue({ user, tokens });
    authServiceMock.getProfile.mockResolvedValue(user);

    await expect(
      controller.registerClient({
        name: user.name,
        email: user.email,
        password: 'password123',
      }),
    ).resolves.toEqual({ user, tokens });

    await expect(
      controller.login({
        email: user.email,
        password: 'password123',
      }),
    ).resolves.toEqual({ user, tokens });

    await expect(
      controller.refresh({
        refreshToken: tokens.refreshToken,
      }),
    ).resolves.toEqual({ user, tokens });

    await expect(
      controller.me({
        userId: user._id,
      }),
    ).resolves.toEqual(user);

    expect(authServiceMock.registerClient).toHaveBeenCalledTimes(1);
    expect(authServiceMock.login).toHaveBeenCalledTimes(1);
    expect(authServiceMock.refreshTokens).toHaveBeenCalledTimes(1);
    expect(authServiceMock.getProfile).toHaveBeenCalledTimes(1);
  });
});
