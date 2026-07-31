const DEFAULT_BUCKET = "PoperL";

const getSupabaseConfig = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://immrqbavmputmeknhkhe.supabase.co",
  key:
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "",
  bucket: process.env.SUPABASE_BUCKET || DEFAULT_BUCKET,
});

const normalizePath = (path = "") => String(path).replace(/^\/+|\/+$/g, "");

const extractSupabasePath = (value) => {
  if (!value || typeof value !== "string") return null;
  const marker = `/storage/v1/object/public/${DEFAULT_BUCKET}/`;
  const index = value.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(value.slice(index + marker.length).split("?")[0]);
};

const collectMessageStoragePaths = (messages = []) => {
  const paths = [];
  messages.forEach((message) => {
    ["imagePath", "audioPath", "filePath", "storagePath"].forEach((key) => {
      if (message?.[key]) paths.push(message[key]);
    });
    ["imageUrl", "audioUrl", "fileUrl"].forEach((key) => {
      const path = extractSupabasePath(message?.[key]);
      if (path) paths.push(path);
    });
  });
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
};

const collectQuizStoragePaths = (quiz = {}) => {
  const paths = [];
  (quiz.questions || []).forEach((question) => {
    if (question.storagePath) paths.push(question.storagePath);
    const imagePath = extractSupabasePath(question.imageUrl);
    if (imagePath) paths.push(imagePath);
  });
  (quiz.attempts || []).forEach((attempt) => {
    Object.values(attempt.answers || {}).forEach((answer) => {
      if (answer?.storagePath) paths.push(answer.storagePath);
      const imagePath = extractSupabasePath(answer?.imageUrl);
      if (imagePath) paths.push(imagePath);
    });
  });
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
};

const makeSupabaseStorage = () => {
  const { url, key, bucket } = getSupabaseConfig();
  const enabled = Boolean(url && key && bucket);
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  // Deleting objects needs the service role key. The config falls back through
  // SUPABASE_ANON_KEY and VITE_SUPABASE_ANON_KEY, and with an anon key every
  // delete comes back 4xx - which this module used to swallow, so chats and
  // quizzes were removed from Mongo while their images, voice notes and
  // attachments stayed in the bucket forever. Say so once, at startup.
  if (enabled && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      "[supabase] SUPABASE_SERVICE_ROLE_KEY is unset; falling back to an anon key. " +
      "Storage deletes will be rejected and orphan every file behind a deleted chat or quiz."
    );
  }

  const listFolder = async (prefix) => {
    if (!enabled) return [];
    const cleanPrefix = normalizePath(prefix);
    const response = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prefix: cleanPrefix,
        limit: 1000,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!response.ok) {
      // returning [] here reads as "the folder is empty", so a permissions
      // failure looked identical to nothing-to-delete
      console.warn(
        `[supabase] list ${bucket}/${cleanPrefix} failed: ${response.status} ${response.statusText}`
      );
      return [];
    }
    const items = await response.json();
    if (!Array.isArray(items)) return [];

    const paths = [];
    for (const item of items) {
      const itemPath = `${cleanPrefix}/${item.name}`.replace(/^\/+/, "");
      if (item.id || item.metadata) paths.push(itemPath);
      else paths.push(...(await listFolder(itemPath)));
    }
    return paths;
  };

  const deletePaths = async (paths = []) => {
    if (!enabled) return { skipped: true, deleted: 0, failed: 0 };
    const uniquePaths = [...new Set(paths.map(normalizePath).filter(Boolean))];
    let deleted = 0;
    let failed = 0;
    for (let index = 0; index < uniquePaths.length; index += 100) {
      const chunk = uniquePaths.slice(index, index + 100);
      const response = await fetch(`${url}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ prefixes: chunk }),
      });
      if (response.ok) {
        deleted += chunk.length;
      } else {
        // a rejected delete used to be indistinguishable from a successful one:
        // the count simply did not go up, and nothing was logged
        failed += chunk.length;
        console.warn(
          `[supabase] delete of ${chunk.length} object(s) failed: ` +
          `${response.status} ${response.statusText}`
        );
      }
    }
    return { skipped: false, deleted, failed };
  };

  const deleteFolders = async (folders = []) => {
    const paths = [];
    for (const folder of folders) {
      paths.push(...(await listFolder(folder)));
    }
    return deletePaths(paths);
  };

  return { collectMessageStoragePaths, collectQuizStoragePaths, deletePaths, deleteFolders, enabled };
};

module.exports = { makeSupabaseStorage, collectMessageStoragePaths, collectQuizStoragePaths, extractSupabasePath };
