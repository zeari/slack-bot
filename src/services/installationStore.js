import pkg from "@slack/oauth";
const { Installation } = pkg;

/**
 * Custom Installation Store for Bolt OAuth
 * This tells Bolt which token to use for each workspace
 */
export class CustomInstallationStore {
  constructor(store, updateStoreWithChangeDetection) {
    this.store = store;
    this.updateStoreWithChangeDetection = updateStoreWithChangeDetection;
  }

  /**
   * Store installation data for a workspace
   */
  async storeInstallation(installation, logger) {
    try {
      const teamId = installation.team?.id;
      if (!teamId) {
        throw new Error("No team ID in installation");
      }

      console.log(
        `💾 Storing installation for workspace: ${installation.team?.name} (${teamId})`
      );

      await this.updateStoreWithChangeDetection(
        this.store,
        (store) => {
          if (!store.installations) {
            store.installations = {};
          }
          store.installations[teamId] = installation;
        },
        `OAuth installation for workspace ${installation.team?.name} (${teamId})`
      );

      console.log(`✅ Installation stored for workspace: ${teamId}`);
    } catch (error) {
      console.error("❌ Failed to store installation:", error);
      throw error;
    }
  }

  /**
   * Fetch installation data for a workspace
   * This is the key method that tells Bolt which token to use
   */
  async fetchInstallation(query, logger) {
    try {
      const { teamId, enterpriseId } = query;

      if (!teamId) {
        console.log("🔍 No teamId in fetchInstallation query");
        return null;
      }

      console.log(`🔍 Fetching installation for workspace: ${teamId}`);

      const installation = this.store.installations?.[teamId];

      if (!installation) {
        console.log(`❌ No installation found for workspace: ${teamId}`);
        return null;
      }

      console.log(`✅ Found installation for workspace: ${teamId}`);
      console.log(`🔑 Bot token available: ${!!installation.bot?.token}`);
      console.log(`🔑 User token available: ${!!installation.user?.token}`);

      return installation;
    } catch (error) {
      console.error("❌ Failed to fetch installation:", error);
      return null;
    }
  }

  /**
   * Delete installation data for a workspace
   */
  async deleteInstallation(query, logger) {
    try {
      const { teamId, enterpriseId } = query;

      if (!teamId) {
        console.log("🔍 No teamId in deleteInstallation query");
        return;
      }

      console.log(`🗑️ Deleting installation for workspace: ${teamId}`);

      await this.updateStoreWithChangeDetection(
        this.store,
        (store) => {
          if (store.installations && store.installations[teamId]) {
            delete store.installations[teamId];
          }
        },
        `Delete installation for workspace ${teamId}`
      );

      console.log(`✅ Installation deleted for workspace: ${teamId}`);
    } catch (error) {
      console.error("❌ Failed to delete installation:", error);
      throw error;
    }
  }
}
