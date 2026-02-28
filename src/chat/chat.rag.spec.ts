import { ChatService } from './chat.service';
import { UserRole } from '../common/enums/role.enum';

describe('ChatService RAG retrieval', () => {
  const createMock = jest.fn();
  const findMock = jest.fn();
  const retrieveChunksMock = jest.fn();

  const chatModelMock = {
    find: findMock,
    create: createMock,
  };

  const lawSourcesServiceMock = {
    retrieveChunks: retrieveChunksMock,
  };

  const configServiceMock = {
    get: jest.fn().mockReturnValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    findMock.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
  });

  it('returns grounded response with citations when chunks exist', async () => {
    retrieveChunksMock.mockResolvedValue([
      {
        chunkId: 'chunk-1',
        sourceId: 'source-1',
        sourceTitle: 'Contract Law Handbook',
        chunkText: 'Offer and acceptance are core elements of contract formation.',
        metadata: { chapter: '1' },
        score: 0.91,
      },
    ]);

    const service = new ChatService(
      chatModelMock as any,
      configServiceMock as any,
      lawSourcesServiceMock as any,
    );

    const result = await service.ask('user-1', UserRole.CLIENT, {
      message: 'What forms a valid contract?',
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.answer).toContain('Based on available sources');
    expect(result.citations).toEqual([
      {
        sourceTitle: 'Contract Law Handbook',
        sourceId: 'source-1',
        chunkId: 'chunk-1',
        metadata: { chapter: '1' },
      },
    ]);
    expect(result.retrievedPreview[0]?.sourceTitle).toBe('Contract Law Handbook');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('returns not-found response when retrieval confidence is weak', async () => {
    retrieveChunksMock.mockResolvedValue([
      {
        chunkId: 'chunk-2',
        sourceId: 'source-2',
        sourceTitle: 'Tax Code Notes',
        chunkText: 'This chunk is weakly related.',
        metadata: null,
        score: 0.11,
      },
    ]);

    const service = new ChatService(
      chatModelMock as any,
      configServiceMock as any,
      lawSourcesServiceMock as any,
    );

    const result = await service.ask('user-1', UserRole.CLIENT, {
      message: 'How do I patent software in Europe?',
    });

    expect(result.answer).toBe("I couldn't find this in the provided law books.");
    expect(result.citations).toEqual([]);
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
