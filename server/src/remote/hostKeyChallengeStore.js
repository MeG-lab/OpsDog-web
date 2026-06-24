import { randomUUID } from 'node:crypto';

const buildInvalidChallengeError = () => {
  const error = new Error('SSH host-key confirmation is invalid or has expired.');
  error.code = 'HOST_KEY_CHALLENGE_INVALID';
  error.statusCode = 400;
  return error;
};

export const createHostKeyChallengeStore = ({
  now = () => Date.now(),
  createToken = () => randomUUID(),
  ttlMs = 60_000,
} = {}) => {
  const challenges = new Map();

  const purgeExpired = () => {
    const currentTime = now();
    for (const [token, challenge] of challenges.entries()) {
      if (challenge.expiresAt <= currentTime) challenges.delete(token);
    }
  };

  return {
    issue: ({ profileId, observedKey }) => {
      purgeExpired();
      const token = createToken();
      challenges.set(token, {
        profileId,
        observedKey,
        expiresAt: now() + ttlMs,
      });
      return token;
    },

    consume: (token, profileId) => {
      const challenge = challenges.get(token);
      challenges.delete(token);
      if (!challenge || challenge.profileId !== profileId || challenge.expiresAt <= now()) {
        throw buildInvalidChallengeError();
      }
      return challenge.observedKey;
    },
  };
};
