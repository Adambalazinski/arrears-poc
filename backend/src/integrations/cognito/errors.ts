export class CredentialsExpiredError extends Error {
  constructor(public readonly organisationId: string) {
    super(`Refresh token for organisation ${organisationId} is no longer accepted by Cognito`);
    this.name = 'CredentialsExpiredError';
  }
}
