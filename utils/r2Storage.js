const crypto = require("crypto");

const DEFAULT_BUCKET = "poperl";
const LEGACY_SUPABASE_BUCKET = "PoperL";

const normalizePath = (path = "") =>
  String(path)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");

const encodePath = (path = "") =>
  normalizePath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const hmac = (key, value, encoding) => crypto.createHmac("sha256", key).update(value).digest(encoding);
const sha256 = (value, encoding = "hex") => crypto.createHash("sha256").update(value).digest(encoding);

const amzDate = (date = new Date()) =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const dateStamp = (date = new Date()) =>
  date.toISOString().slice(0, 10).replace(/-/g, "");

const escapeXml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const decodeXml = (value = "") =>
  String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const getR2Config = () => {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const endpoint = (process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")).replace(/\/+$/g, "");
  return {
    accountId,
    endpoint,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || DEFAULT_BUCKET,
    publicBaseUrl: (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/g, ""),
    uploadUrlTtlSeconds: Math.min(Math.max(Number(process.env.R2_UPLOAD_URL_TTL_SECONDS) || 600, 60), 3600),
  };
};

const getHost = (endpoint) => new URL(endpoint).host;

const getSigningKey = (secretAccessKey, stamp) => {
  const kDate = hmac(`AWS4${secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
};

const makeCanonicalQuery = (params) =>
  Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

const signRequest = ({ method, key = "", query = {}, headers = {}, payloadHash = "UNSIGNED-PAYLOAD", expires }) => {
  const config = getR2Config();
  if (!config.endpoint || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
    throw new Error("R2 storage is not configured.");
  }

  const now = new Date();
  const stamp = dateStamp(now);
  const requestDate = amzDate(now);
  const credentialScope = `${stamp}/auto/s3/aws4_request`;
  const host = getHost(config.endpoint);
  const normalizedHeaders = {
    host,
    ...Object.entries(headers).reduce((acc, [header, value]) => {
      acc[String(header).toLowerCase()] = String(value).trim();
      return acc;
    }, {}),
  };
  const signedHeaders = Object.keys(normalizedHeaders).sort().join(";");
  const baseQuery = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": requestDate,
    "X-Amz-Expires": String(expires || config.uploadUrlTtlSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  if (payloadHash === "UNSIGNED-PAYLOAD") {
    baseQuery["X-Amz-Content-Sha256"] = "UNSIGNED-PAYLOAD";
  }

  const encodedBucket = encodeURIComponent(config.bucket);
  const encodedKey = encodePath(key);
  const canonicalUri = encodedKey ? `/${encodedBucket}/${encodedKey}` : `/${encodedBucket}`;
  const canonicalQuery = makeCanonicalQuery(baseQuery);
  const canonicalHeaders = Object.keys(normalizedHeaders)
    .sort()
    .map((header) => `${header}:${normalizedHeaders[header]}\n`)
    .join("");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    requestDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = hmac(getSigningKey(config.secretAccessKey, stamp), stringToSign, "hex");
  const url = `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, host, config };
};

const signedFetch = async ({ method, key = "", query = {}, headers = {}, body = null, payloadHash = null }) => {
  const config = getR2Config();
  if (!config.endpoint || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
    throw new Error("R2 storage is not configured.");
  }

  const now = new Date();
  const stamp = dateStamp(now);
  const requestDate = amzDate(now);
  const credentialScope = `${stamp}/auto/s3/aws4_request`;
  const contentHash = payloadHash || (body ? sha256(body) : sha256(""));
  const host = getHost(config.endpoint);
  const encodedBucket = encodeURIComponent(config.bucket);
  const encodedKey = encodePath(key);
  const canonicalUri = encodedKey ? `/${encodedBucket}/${encodedKey}` : `/${encodedBucket}`;
  const canonicalQuery = makeCanonicalQuery(query);
  const requestHeaders = {
    ...headers,
    "x-amz-content-sha256": contentHash,
    "x-amz-date": requestDate,
  };
  const normalizedHeaders = {
    host,
    ...Object.entries(requestHeaders).reduce((acc, [header, value]) => {
      acc[String(header).toLowerCase()] = String(value).trim();
      return acc;
    }, {}),
  };
  const signedHeaders = Object.keys(normalizedHeaders).sort().join(";");
  const canonicalHeaders = Object.keys(normalizedHeaders)
    .sort()
    .map((header) => `${header}:${normalizedHeaders[header]}\n`)
    .join("");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, contentHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    requestDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = hmac(getSigningKey(config.secretAccessKey, stamp), stringToSign, "hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${config.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  return fetch(url, {
    method,
    headers: {
      ...requestHeaders,
      Authorization: authorization,
    },
    body,
  });
};

const extractLegacySupabasePath = (value) => {
  if (!value || typeof value !== "string") return null;
  const marker = `/storage/v1/object/public/${LEGACY_SUPABASE_BUCKET}/`;
  const index = value.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(value.slice(index + marker.length).split("?")[0]);
};

const extractR2Path = (value) => {
  if (!value || typeof value !== "string") return null;
  const { publicBaseUrl } = getR2Config();
  if (!publicBaseUrl || !value.startsWith(`${publicBaseUrl}/`)) return null;
  return decodeURIComponent(value.slice(publicBaseUrl.length + 1).split("?")[0]);
};

const extractStoragePath = (value) => extractR2Path(value) || extractLegacySupabasePath(value);

const collectMessageStoragePaths = (messages = []) => {
  const paths = [];
  messages.forEach((message) => {
    ["imagePath", "audioPath", "filePath", "storagePath"].forEach((field) => {
      if (message?.[field]) paths.push(message[field]);
    });
    ["imageUrl", "audioUrl", "fileUrl"].forEach((field) => {
      const path = extractStoragePath(message?.[field]);
      if (path) paths.push(path);
    });
  });
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
};

const collectQuizStoragePaths = (quiz = {}) => {
  const paths = [];
  (quiz.questions || []).forEach((question) => {
    if (question.storagePath) paths.push(question.storagePath);
    const imagePath = extractStoragePath(question.imageUrl);
    if (imagePath) paths.push(imagePath);
  });
  (quiz.attempts || []).forEach((attempt) => {
    Object.values(attempt.answers || {}).forEach((answer) => {
      if (answer?.storagePath) paths.push(answer.storagePath);
      const imagePath = extractStoragePath(answer?.imageUrl);
      if (imagePath) paths.push(imagePath);
    });
  });
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
};

const parseListObjectsXml = (xml = "") => {
  const items = [];
  const contentBlocks = String(xml).match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
  contentBlocks.forEach((block) => {
    const read = (tag) => {
      const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return match ? decodeXml(match[1]) : "";
    };
    const key = read("Key");
    if (!key) return;
    items.push({
      path: key,
      name: key.split("/").pop(),
      size: Number(read("Size")) || 0,
      createdAt: read("LastModified") || null,
      updatedAt: read("LastModified") || null,
      mimeType: "",
    });
  });
  return items;
};

const makeR2Storage = () => {
  const config = getR2Config();
  const enabled = Boolean(config.endpoint && config.accessKeyId && config.secretAccessKey && config.bucket);

  if (!enabled) {
    console.warn("[r2] R2 storage is not fully configured. Upload/list/delete endpoints will fail until env vars are set.");
  }
  if (enabled && !config.publicBaseUrl) {
    console.warn("[r2] R2_PUBLIC_BASE_URL is unset. Uploaded files will not have public URLs.");
  }

  const getPublicUrl = (path) => {
    const cleanPath = normalizePath(path);
    if (!config.publicBaseUrl || !cleanPath) return "";
    return `${config.publicBaseUrl}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
  };

  const getUploadUrl = ({ path, contentType = "application/octet-stream" }) => {
    const cleanPath = normalizePath(path);
    if (!cleanPath) throw new Error("Storage path is required.");
    const { url } = signRequest({
      method: "PUT",
      key: cleanPath,
      headers: {},
      payloadHash: "UNSIGNED-PAYLOAD",
      expires: config.uploadUrlTtlSeconds,
    });
    return { path: cleanPath, uploadUrl: url, url: getPublicUrl(cleanPath), contentType };
  };

  const listFolder = async (prefix) => {
    if (!enabled) return [];
    const cleanPrefix = normalizePath(prefix);
    const response = await signedFetch({
      method: "GET",
      query: {
        "list-type": "2",
        prefix: cleanPrefix ? `${cleanPrefix.replace(/\/+$/g, "")}/` : "",
        "max-keys": "1000",
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn(
        `[r2] list ${config.bucket}/${cleanPrefix} failed: ${response.status} ${response.statusText} ` +
        errorText.slice(0, 300)
      );
      return [];
    }
    const xml = await response.text();
    return parseListObjectsXml(xml).map((item) => ({ ...item, url: getPublicUrl(item.path) }));
  };

  const deletePaths = async (paths = []) => {
    if (!enabled) return { skipped: true, deleted: 0, failed: 0 };
    const uniquePaths = [...new Set(paths.map(normalizePath).filter(Boolean))];
    let deleted = 0;
    let failed = 0;
    for (const path of uniquePaths) {
      const response = await signedFetch({ method: "DELETE", key: path });
      if (response.ok || response.status === 404) deleted += 1;
      else {
        failed += 1;
        const errorText = await response.text().catch(() => "");
        console.warn(
          `[r2] delete ${config.bucket}/${path} failed: ${response.status} ${response.statusText} ` +
          errorText.slice(0, 300)
        );
      }
    }
    return { skipped: false, deleted, failed };
  };

  const deleteFolders = async (folders = []) => {
    const paths = [];
    for (const folder of folders) {
      const items = await listFolder(folder);
      paths.push(...items.map((item) => item.path));
    }
    return deletePaths(paths);
  };

  return {
    enabled,
    config,
    getPublicUrl,
    getUploadUrl,
    listFolder,
    collectMessageStoragePaths,
    collectQuizStoragePaths,
    deletePaths,
    deleteFolders,
  };
};

module.exports = {
  makeR2Storage,
  collectMessageStoragePaths,
  collectQuizStoragePaths,
  extractStoragePath,
  normalizePath,
};
