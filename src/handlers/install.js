// OAuth installation and setup handlers
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from "../config/index.js";

// OAuth installation endpoint
export function setupInstallRoutes(
  receiver,
  store,
  updateStoreWithChangeDetection,
  workspaceTokens,
  installationStore
) {
  receiver.router.get("/slack/install", (req, res) => {
    const scopes =
      "app_mentions:read,channels:read,channels:join,chat:write,chat:write.public,commands,groups:read,im:history,im:read,im:write,mpim:write,users:read";

    const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(
      process.env.BASE_URL || "http://localhost:3000"
    )}/slack/oauth_redirect`;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Install Hypernative Slack Bot</title>
          <style>
              body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
              .install-btn { background: #4A154B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 20px 0; }
              .install-btn:hover { background: #611f69; }
              .feature { margin: 10px 0; }
              .feature::before { content: "✅ "; }
              .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 4px; margin: 20px 0; }
              .warning::before { content: "⚠️ "; font-weight: bold; }
          </style>
      </head>
      <body>
          <h1>🤖 Hypernative Slack Bot</h1>
          <p>Get personalized Hypernative alerts delivered directly to your Slack channels.</p>
          
          <div class="warning">
              <strong>Important:</strong> For the best experience, install this bot in your own workspace. 
              If you're from a different workspace, you'll need to install it there to access the App Home feature.
          </div>
          
          <h3>Features:</h3>
          <div class="feature">Personal webhook URLs for each user</div>
          <div class="feature">Configurable alert destinations</div>
          <div class="feature">Interactive setup via App Home or DM</div>
          <div class="feature">Accept/Deny transaction buttons</div>
          <div class="feature">Easy-to-use App Home interface</div>
          
          <a href="${installUrl}" class="install-btn">Add to Slack</a>
          
          <h3>After Installation:</h3>
          <p>1. Click on the bot's profile and go to the <strong>Home</strong> tab</p>
          <p>2. Click "Get Started" to configure your alerts</p>
          <p>3. Get your unique webhook URL and add it to Hypernative</p>
          <p>4. Or DM the bot with "hi" to get started interactively</p>
          
          <h3>Getting Started:</h3>
          <p>After installing, you can:</p>
          <ul>
              <li>Visit the bot's <strong>Home</strong> tab for setup and configuration</li>
              <li>DM the bot with "hi" or "help" for interactive assistance</li>
              <li>Configure your alert destination and get your webhook URL</li>
          </ul>
      </body>
      </html>
    `);
  });

  // OAuth redirect handler
  receiver.router.get("/slack/oauth_redirect", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      console.log(`❌ OAuth error: ${error}`);
      return res.send(`
        <h1>❌ Installation Failed</h1>
        <p>Error: ${error}</p>
        <a href="/slack/install">Try Again</a>
      `);
    }

    if (!code) {
      return res.send(`
        <h1>❌ Installation Failed</h1>
        <p>No authorization code received</p>
        <a href="/slack/install">Try Again</a>
      `);
    }

    try {
      // Exchange code for access token
      const result = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: SLACK_CLIENT_ID,
          client_secret: SLACK_CLIENT_SECRET,
          code: code,
          redirect_uri: `${
            process.env.BASE_URL || "http://localhost:3000"
          }/slack/oauth_redirect`,
        }),
      });

      const oauthData = await result.json();

      if (!oauthData.ok) {
        throw new Error(oauthData.error);
      }

      console.log(
        `✅ OAuth successful for team: ${oauthData.team.name} (${oauthData.team.id})`
      );

      // Store installation data using the installation store
      const installation = {
        team: oauthData.team,
        enterprise: oauthData.enterprise,
        bot: {
          id: oauthData.bot_user_id,
          userId: oauthData.bot_user_id,
          token: oauthData.access_token,
          scopes: oauthData.scope,
          // Store refresh token if available (for token rotation)
          refreshToken: oauthData.refresh_token,
          expiresAt: oauthData.expires_in
            ? new Date(Date.now() + oauthData.expires_in * 1000).toISOString()
            : null,
        },
        user: {
          id: oauthData.authed_user?.id,
          token: oauthData.authed_user?.access_token,
          // Store user refresh token if available
          refreshToken: oauthData.authed_user?.refresh_token,
          expiresAt: oauthData.authed_user?.expires_in
            ? new Date(
                Date.now() + oauthData.authed_user.expires_in * 1000
              ).toISOString()
            : null,
        },
        isEnterpriseInstall: !!oauthData.enterprise,
        installedAt: new Date().toISOString(),
        // Store the refresh token at the installation level too
        refreshToken: oauthData.refresh_token,
        expiresAt: oauthData.expires_in
          ? new Date(Date.now() + oauthData.expires_in * 1000).toISOString()
          : null,
      };

      // Save installation data using the installation store
      try {
        await installationStore.storeInstallation(installation);

        console.log(
          `💾 Installation data saved for workspace: ${oauthData.team.name} (${oauthData.team.id})`
        );
        console.log(
          `📊 Total installations: ${Object.keys(store.installations).length}`
        );

        // Update workspace tokens map for backward compatibility
        workspaceTokens.set(oauthData.team.id, {
          token: installation.bot.token,
          team: installation.team,
          bot: installation.bot.id,
          user: installation.user.id,
          scopes: installation.bot.scopes,
          installedAt: installation.installedAt,
        });
        console.log(
          `🔄 Updated workspace tokens map (${workspaceTokens.size} workspaces)`
        );
      } catch (saveError) {
        console.error(`❌ Failed to save installation data:`, saveError);
        // Continue with success page even if save fails
      }

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Installation Successful</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
                .success { color: #28a745; font-size: 48px; }
            </style>
        </head>
        <body>
            <div class="success">✅</div>
            <h1>Installation Successful!</h1>
            <p>Hypernative Slack Bot has been installed to <strong>${oauthData.team.name}</strong></p>
            
            <h3>Next Steps:</h3>
            <p>1. Go to your Slack workspace</p>
            <p>2. Click on the Hypernative bot profile and go to the <strong>Home</strong> tab</p>
            <p>3. Click "Get Started" to configure your alerts</p>
            <p>4. Or DM the bot with "hi" to get started interactively</p>
            
            <p><a href="slack://open">Open Slack</a></p>
        </body>
        </html>
      `);
    } catch (error) {
      console.error(`❌ OAuth exchange failed:`, error);
      res.send(`
        <h1>❌ Installation Failed</h1>
        <p>Failed to complete installation: ${error.message}</p>
        <a href="/slack/install">Try Again</a>
      `);
    }
  });
}
