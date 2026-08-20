export interface IdentityKeyPair {
  readonly publicKey: CryptoKey
  readonly privateKey: CryptoKey
}

export interface OneTimePrekey extends IdentityKeyPair {
  readonly keyId: string
  readonly createdAt: number
}

export interface UserIdentity {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly identityKeyPair: IdentityKeyPair
  readonly signedPrekeyPair: IdentityKeyPair
  readonly oneTimePrekeys: readonly OneTimePrekey[]
  readonly sessionToken: string
  readonly createdAt: number
}

export interface RemoteIdentity {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName?: string
  readonly identityKeyPublic: CryptoKey
  readonly signedPrekeyPublic: CryptoKey
  readonly oneTimePrekey?: CryptoKey
  readonly verified: boolean
  readonly fetchedAt: number
}

export interface RegistrationPublicMaterial {
  readonly displayName: string
  readonly identityKeyPublic: string
  readonly signedPrekeyPublic: string
  readonly signedPrekeySignature: string
  readonly oneTimePrekeys: readonly string[]
}

export interface RegisteredIdentityClaim {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly identityKeyPublic: string
  readonly signedPrekeyPublic: string
  readonly signedPrekeySignature: string
  readonly oneTimePrekeys: readonly string[]
  readonly sessionToken: string
  readonly createdAt: number
}

export interface IdentitySessionClaim {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly createdAt: number
}

export interface RemoteIdentityBundle {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName?: string
  readonly identityKeyPublic: string
  readonly signedPrekeyPublic: string
  readonly signedPrekeySignature: string
  readonly oneTimePrekey?: string
  readonly remainingPrekeys: number
}

export interface IdentityProvider {
  register(material: RegistrationPublicMaterial): Promise<RegisteredIdentityClaim>
  verifySession(sessionToken: string): Promise<IdentitySessionClaim>
  lookupKeys(phoneNumber: string, sessionToken: string): Promise<RemoteIdentityBundle>
  replenishPrekeys(sessionToken: string, oneTimePrekeys: readonly string[]): Promise<number>
}

export interface IdentityStorage {
  loadLocalIdentity(): Promise<UserIdentity | undefined>
  saveLocalIdentity(identity: UserIdentity): Promise<void>
  deleteLocalIdentity(): Promise<void>
  loadRemoteIdentity(userId: string): Promise<RemoteIdentity | undefined>
  saveRemoteIdentity(identity: RemoteIdentity): Promise<void>
  close(): Promise<void>
}
