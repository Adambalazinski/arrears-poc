export interface RequestUser {
  id: string;
  email: string;
}

export interface AuthenticatedRequest {
  user: RequestUser;
}
