export interface IdentityKeyPair {
  readonly publicKey: CryptoKey
  readonly privateKey: CryptoKey
}

export interface IdentityRecipient {
  readonly userId: string
  readonly phoneNumber: string
}

export interface OneTimePrekey extends IdentityKeyPair {
  readonly keyId: string
  readonly createdAt: number
  /** Set only after the provider has accepted this public prekey. */
  readonly publishedAt?: number
}

export interface SignedPrekey extends IdentityKeyPair {
  readonly keyId: string
  readonly createdAt: number
}

export interface UserIdentity {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly identityKeyPair: IdentityKeyPair
  readonly signedPrekeyPair: SignedPrekey
  /** Retained so delayed ciphertext addressed to an older selector remains decryptable. */
  readonly retiredSignedPrekeys: readonly SignedPrekey[]
  /** Crash-recovery staging slot; never advertised until provider rotation succeeds. */
  readonly pendingSignedPrekey?: SignedPrekey
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
  readonly signedPrekeyPublic: string
  readonly signedPrekeyRotationRequired: boolean
  readonly prekeyCount: number
  readonly createdAt: number
}

export interface SignedPrekeyPublicMaterial {
  readonly signedPrekeyPublic: string
  readonly signedPrekeySignature: string
}

export interface SignedPrekeyRotationClaim extends SignedPrekeyPublicMaterial {
  readonly rotatedAt: number
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
  rotateSignedPrekey(
    sessionToken: string,
    material: SignedPrekeyPublicMaterial
  ): Promise<SignedPrekeyRotationClaim>
}

export interface IdentityStorage {
  loadLocalIdentity(): Promise<UserIdentity | undefined>
  saveLocalIdentity(identity: UserIdentity): Promise<void>
  deleteLocalIdentity(): Promise<void>
  loadRemoteIdentity(userId: string): Promise<RemoteIdentity | undefined>
  saveRemoteIdentity(identity: RemoteIdentity): Promise<void>
  close(): Promise<void>
}
