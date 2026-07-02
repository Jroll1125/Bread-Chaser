export declare function isAvailable(): Promise<boolean>;
export type IsAvailable = typeof isAvailable;

export declare function getSecret(name: string): Promise<string | null>;
export type GetSecret = typeof getSecret;

export declare function setSecret(name: string, value: string): Promise<void>;
export type SetSecret = typeof setSecret;

export declare function removeSecret(name: string): Promise<void>;
export type RemoveSecret = typeof removeSecret;
