// storage.js — User profile management
// Profile is stored in chrome.storage.local as a flat JSON object

const Storage = (() => {

  const PROFILE_KEY = 'userProfile';
  const LEARNED_KEY = 'learnedMappings'; // hostname -> { fieldName -> profileKey }

  async function getProfile() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PROFILE_KEY], (result) => {
        resolve(result[PROFILE_KEY] || {});
      });
    });
  }

  async function saveProfile(profile) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [PROFILE_KEY]: profile }, resolve);
    });
  }

  async function updateProfileField(key, value) {
    const profile = await getProfile();
    profile[key] = value;
    await saveProfile(profile);
    return profile;
  }

  async function getLearnedMappings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([LEARNED_KEY], (result) => {
        resolve(result[LEARNED_KEY] || {});
      });
    });
  }

  // Store what we learned: for this hostname, fieldName maps to profileKey
  async function learnMapping(hostname, fieldName, profileKey) {
    const mappings = await getLearnedMappings();
    if (!mappings[hostname]) mappings[hostname] = {};
    mappings[hostname][fieldName] = profileKey;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [LEARNED_KEY]: mappings }, resolve);
    });
  }

  async function getMappingsForHost(hostname) {
    const mappings = await getLearnedMappings();
    return mappings[hostname] || {};
  }

  async function isSetupComplete() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['setupComplete'], (result) => {
        resolve(!!result.setupComplete);
      });
    });
  }

  async function markSetupComplete() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ setupComplete: true }, resolve);
    });
  }

  async function exportData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
  }

  async function clearAll() {
    return new Promise((resolve) => {
      chrome.storage.local.clear(resolve);
    });
  }

  return {
    getProfile,
    saveProfile,
    updateProfileField,
    getLearnedMappings,
    learnMapping,
    getMappingsForHost,
    isSetupComplete,
    markSetupComplete,
    exportData,
    clearAll
  };
})();
