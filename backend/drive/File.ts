/**
 * The metadata for a file.
 */

type ID = string;

export interface ContentHints {
  indexableText: string;
  thumbnail: {
    image: string;
    mimeType: string;
  };
}

// https://developers.google.com/drive/api/reference/rest/v3/files#File
export interface File {
  fileExtension?: string;
  md5Checksum?: string;
  contentHints?: ContentHints;
  mimeType: string;
  parents: ID[];
  thumbnailLink?: string;
  size?: number;
  id: ID;
  name: string;
  description?: string;
  createdTime?: string;
  modifiedTime?: string;
  originalFilename?: string;
  fullFileExtension?: string;
  properties?: Record<string, unknown>;
  teamDriveId?: string;
}
