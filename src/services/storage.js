// Storage service for managing data persistence
import fs from "fs";
import {
  PERSIST_PATH,
  USE_GIST_STORAGE,
  GITHUB_TOKEN,
  GIST_ID,
} from "../config/index.js";

// ---- GitHub Gist Storage Functions ----
async function loadFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) {
    throw new Error("GitHub token or Gist ID not configured");
  }

  try {
    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Hypernative-Slack-Bot",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const gist = await response.json();
    const content = gist.files["storage.json"]?.content;

    if (!content) {
      throw new Error("No storage.json file found in Gist");
    }

    const parsed = JSON.parse(content);
    const store = {
      destinations: parsed.destinations || {},
      userTokens: parsed.userTokens || {},
      tokenToUser: parsed.tokenToUser || {},
      installations: parsed.installations || {},
    };

    console.log(
      `📂 ✅ Loaded storage from Gist: ${
        Object.keys(store.userTokens).length
      } user tokens, ${Object.keys(store.destinations).length} destinations`
    );
    return store;
  } catch (error) {
    console.log(`📂 ❌ Failed to load from Gist: ${error.message}`);
    throw error;
  }
}

async function saveToGist(store) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    throw new Error("GitHub token or Gist ID not configured");
  }

  try {
    const content = JSON.stringify(store, null, 2);

    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Hypernative-Slack-Bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: {
          "storage.json": {
            content: content,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    console.log(`📂 ✅ Saved storage to Gist successfully`);
  } catch (error) {
    console.log(`📂 ❌ Failed to save to Gist: ${error.message}`);
    throw error;
  }
}

// ---- Tiny persistence (JSON file or Gist) ----
async function loadStore() {
  if (USE_GIST_STORAGE) {
    console.log(`📂 Loading storage from GitHub Gist: ${GIST_ID}`);
    try {
      return await loadFromGist();
    } catch (error) {
      console.log(`📂 ❌ Gist storage failed, falling back to local file`);
    }
  }

  console.log(`📂 Loading storage from: ${PERSIST_PATH}`);

  try {
    const raw = fs.readFileSync(PERSIST_PATH, "utf8");
    const parsed = JSON.parse(raw);

    // Ensure all required fields exist (backward compatibility)
    const store = {
      destinations: parsed.destinations || {},
      userTokens: parsed.userTokens || {},
      tokenToUser: parsed.tokenToUser || {},
      installations: parsed.installations || {},
    };

    console.log(
      `📂 ✅ Loaded storage: ${
        Object.keys(store.userTokens).length
      } user tokens, ${Object.keys(store.destinations).length} destinations`
    );
    console.log(
      `📂 Available user tokens: ${Object.keys(store.userTokens).join(", ")}`
    );
    return store;
  } catch (e) {
    console.log(
      `📂 ❌ Failed to load storage from ${PERSIST_PATH}: ${e.message}`
    );
    console.log(`📂 Creating new storage file at ${PERSIST_PATH}`);
    const newStore = {
      destinations: {}, // { [userId]: { channel: 'C..' } }
      userTokens: {}, // { [userId]: 'unique-token' }
      tokenToUser: {}, // { 'unique-token': userId } - reverse lookup
      installations: {}, // { [teamId]: installation data }
    };

    // Try to save the new store to verify the path works
    try {
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(newStore, null, 2));
      console.log(`📂 ✅ Created new storage file successfully`);
    } catch (saveError) {
      console.log(`📂 ❌ Failed to create storage file: ${saveError.message}`);
    }

    return newStore;
  }
}

async function saveStore(store) {
  if (USE_GIST_STORAGE) {
    try {
      await saveToGist(store);
      return;
    } catch (error) {
      console.error(
        `❌ Gist storage failed, falling back to local file:`,
        error
      );
    }
  }

  try {
    // Create backup before saving
    if (fs.existsSync(PERSIST_PATH)) {
      const backupPath = `${PERSIST_PATH}.backup`;
      fs.copyFileSync(PERSIST_PATH, backupPath);
    }

    // Write to temporary file first, then rename (atomic operation)
    const tempPath = `${PERSIST_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
    fs.renameSync(tempPath, PERSIST_PATH);

    console.log(`💾 Storage saved successfully to ${PERSIST_PATH}`);
  } catch (error) {
    console.error(`❌ Failed to save storage:`, error);
    // Try to restore from backup if main save failed
    const backupPath = `${PERSIST_PATH}.backup`;
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, PERSIST_PATH);
        console.log(`🔄 Restored from backup: ${backupPath}`);
      } catch (restoreError) {
        console.error(`❌ Failed to restore from backup:`, restoreError);
      }
    }
    throw error;
  }
}

// Validate and repair storage data
function validateStorage(store) {
  let needsRepair = false;

  // Ensure all required fields exist
  if (!store.destinations || typeof store.destinations !== "object") {
    store.destinations = {};
    needsRepair = true;
  }

  if (!store.userTokens || typeof store.userTokens !== "object") {
    store.userTokens = {};
    needsRepair = true;
  }

  if (!store.tokenToUser || typeof store.tokenToUser !== "object") {
    store.tokenToUser = {};
    needsRepair = true;
  }

  if (!store.installations || typeof store.installations !== "object") {
    store.installations = {};
    needsRepair = true;
  }

  // Validate token mappings consistency
  const orphanedTokens = [];
  for (const [token, userId] of Object.entries(store.tokenToUser)) {
    if (!store.userTokens[userId] || store.userTokens[userId] !== token) {
      orphanedTokens.push(token);
    }
  }

  // Remove orphaned tokens
  orphanedTokens.forEach((token) => {
    delete store.tokenToUser[token];
    needsRepair = true;
  });

  // Validate user tokens consistency
  const orphanedUsers = [];
  for (const [userId, token] of Object.entries(store.userTokens)) {
    if (!store.tokenToUser[token] || store.tokenToUser[token] !== userId) {
      orphanedUsers.push(userId);
    }
  }

  // Remove orphaned users
  orphanedUsers.forEach((userId) => {
    delete store.userTokens[userId];
    needsRepair = true;
  });

  if (needsRepair) {
    console.log("🔧 Storage validation found issues, repairing...");
    saveStore(store);
    console.log("✅ Storage repaired successfully");
  } else {
    console.log("✅ Storage validation passed");
  }

  return store;
}

// Initialize storage on startup
async function initializeStorage() {
  try {
    const store = await loadStore();
    const validatedStore = validateStorage(store);
    console.log(`📂 Storage initialized successfully`);
    return validatedStore;
  } catch (error) {
    console.error(`❌ Failed to initialize storage:`, error);
    // Create empty store as fallback
    return {
      destinations: {},
      userTokens: {},
      tokenToUser: {},
      installations: {},
    };
  }
}

// Safe storage update function that automatically saves
async function updateStore(store, updateFn) {
  try {
    updateFn(store);
    await saveStore(store);
    console.log(`💾 Storage updated and saved immediately`);
  } catch (error) {
    console.error(`❌ Failed to update storage:`, error);
    throw error;
  }
}

// Enhanced storage update function with change detection
async function updateStoreWithChangeDetection(
  store,
  updateFn,
  changeDescription = "storage update"
) {
  try {
    // Create a deep copy to detect changes
    const beforeUpdate = JSON.stringify(store);

    // Apply the update
    updateFn(store);

    // Check if anything actually changed
    const afterUpdate = JSON.stringify(store);

    if (beforeUpdate !== afterUpdate) {
      await saveStore(store);
      console.log(
        `💾 Storage changed (${changeDescription}) - saved immediately`
      );
    } else {
      console.log(
        `💾 No changes detected for ${changeDescription} - skipping save`
      );
    }
  } catch (error) {
    console.error(`❌ Failed to update storage:`, error);
    throw error;
  }
}

export {
  loadStore,
  saveStore,
  validateStorage,
  initializeStorage,
  updateStore,
  updateStoreWithChangeDetection,
};
