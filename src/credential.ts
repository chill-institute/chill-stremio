// Engine issues and verifies Stremio credentials; the adapter only checks shape.
export const credentialPattern = /^v4\.local\.[A-Za-z0-9_-]{43,1015}$/;

export const isCredential = (value: string) => credentialPattern.test(value);

export const redactCredentials = (text: string) =>
  text.replace(/v4\.local\.[A-Za-z0-9_-]+/g, "[credential]");
