// S3/R2/B2 operations via AWS SDK v3 (works with any S3-compatible endpoint).
// Multipart-aware uploads via @aws-sdk/lib-storage for large dumps.

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import type { Destination } from "./db.ts";

function clientFor(dest: Destination): S3Client {
  return new S3Client({
    endpoint: dest.endpoint,
    region: dest.region || "auto",
    credentials: {
      accessKeyId: dest.access_key,
      secretAccessKey: dest.secret_key,
    },
    forcePathStyle: true, // works for both R2 and most S3-compatible providers
  });
}

export type S3Object = {
  key: string;
  size: number;
  lastModified: Date;
};

export async function listObjects(
  dest: Destination,
  prefix?: string,
): Promise<S3Object[]> {
  const client = clientFor(dest);
  const fullPrefix = (dest.path_prefix ?? "") + (prefix ?? "");

  const all: S3Object[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: dest.bucket,
        Prefix: fullPrefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      all.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Newest first
  all.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return all;
}

export async function uploadStream(
  dest: Destination,
  key: string,
  body: Readable,
  contentType = "application/octet-stream",
): Promise<{ etag: string; size: number }> {
  const client = clientFor(dest);
  let size = 0;
  const counted = body.pipe(
    new (require("node:stream").Transform)({
      transform(chunk: Buffer, _enc: any, cb: any) {
        size += chunk.length;
        cb(null, chunk);
      },
    }),
  );
  const upload = new Upload({
    client,
    params: {
      Bucket: dest.bucket,
      Key: (dest.path_prefix ?? "") + key,
      Body: counted,
      ContentType: contentType,
    },
    partSize: 32 * 1024 * 1024, // 32 MiB multipart
    queueSize: 4,
  });

  const result = await upload.done();
  return { etag: (result as any).ETag ?? "", size };
}

export async function getObjectStream(
  dest: Destination,
  key: string,
): Promise<{ body: Readable; size: number; etag: string }> {
  const client = clientFor(dest);
  const fullKey = (dest.path_prefix ?? "") + key;
  const resp = await client.send(
    new GetObjectCommand({ Bucket: dest.bucket, Key: fullKey }),
  );
  if (!resp.Body) throw new Error(`Object ${fullKey} has no body`);
  return {
    body: resp.Body as Readable,
    size: resp.ContentLength ?? 0,
    etag: resp.ETag ?? "",
  };
}

export async function deleteObject(dest: Destination, key: string): Promise<void> {
  const client = clientFor(dest);
  const fullKey = (dest.path_prefix ?? "") + key;
  await client.send(new DeleteObjectCommand({ Bucket: dest.bucket, Key: fullKey }));
}

export async function headObject(
  dest: Destination,
  key: string,
): Promise<{ size: number; lastModified: Date } | null> {
  try {
    const client = clientFor(dest);
    const fullKey = (dest.path_prefix ?? "") + key;
    const resp = await client.send(
      new HeadObjectCommand({ Bucket: dest.bucket, Key: fullKey }),
    );
    return {
      size: resp.ContentLength ?? 0,
      lastModified: resp.LastModified ?? new Date(0),
    };
  } catch {
    return null;
  }
}

/** Pre-signed download URL valid for a short period (default 10 minutes). */
export async function signedDownloadUrl(
  dest: Destination,
  key: string,
  expiresSeconds = 600,
): Promise<string> {
  const client = clientFor(dest);
  const fullKey = (dest.path_prefix ?? "") + key;
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: dest.bucket, Key: fullKey }),
    { expiresIn: expiresSeconds },
  );
}

/** Test bucket reachability + creds work. Returns null on success, error string on failure. */
export async function testDestination(dest: Destination): Promise<string | null> {
  try {
    const client = clientFor(dest);
    await client.send(
      new ListObjectsV2Command({
        Bucket: dest.bucket,
        Prefix: dest.path_prefix ?? "",
        MaxKeys: 1,
      }),
    );
    return null;
  } catch (e: any) {
    return e.message;
  }
}
