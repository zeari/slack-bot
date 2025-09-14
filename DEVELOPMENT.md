# Development Guide

## Project Structure

The codebase has been refactored into a modular structure for better maintainability and debugging:

```
src/
├── config/
│   └── index.js          # Environment configuration
├── handlers/
│   ├── appHome.js        # App Home tab functionality
│   ├── commands.js       # Slash commands and interactive elements
│   ├── install.js        # OAuth installation routes
│   ├── messages.js       # DM and message handlers
│   └── webhooks.js       # Webhook endpoints for Hypernative alerts
├── services/
│   └── storage.js        # Data persistence (local file + GitHub Gist)
└── utils/
    ├── helpers.js        # Utility functions
    └── messageFormatter.js # Message formatting for alerts
```

## VS Code Debugging

### Debug Configurations

1. **Debug Slack Bot** - Debug the main app directly
2. **Debug with Nodemon** - Debug with hot-reload
3. **Debug with Tunnel** - Debug with localtunnel

### How to Debug

1. Open VS Code in the project directory
2. Go to Run and Debug (Ctrl+Shift+D)
3. Select one of the debug configurations
4. Set breakpoints in any file
5. Start debugging

### Debugging Tips

- Set breakpoints in the handlers you want to debug
- Use the "Debug with Nodemon" for hot-reload during development
- Check the Debug Console for detailed logs
- Use the integrated terminal for additional debugging

## Running the Application

### Original App (Monolithic)

```bash
npm start          # Production
npm run dev        # Development with nodemon
npm run dev:hot    # Development with tunnel
```

### New Modular App

```bash
npm run start:new  # Production
npm run dev:new    # Development with nodemon
```

## Key Features

### 1. Modular Architecture

- **Config**: Centralized environment configuration
- **Handlers**: Separated by functionality (webhooks, messages, commands, etc.)
- **Services**: Data persistence and external integrations
- **Utils**: Reusable helper functions

### 2. Enhanced Debugging

- VS Code debug configurations
- Detailed logging for all events
- Breakpoint support in all modules

### 3. Better Error Handling

- Graceful error handling in each module
- Automatic data saving on errors
- Detailed error logging

### 4. Improved Maintainability

- Single responsibility principle
- Clear separation of concerns
- Easy to test individual components

## Development Workflow

1. **Start Development**:

   ```bash
   npm run dev:new
   ```

2. **Debug in VS Code**:

   - Set breakpoints
   - Use "Debug with Nodemon" configuration
   - Step through code

3. **Test Features**:
   - Use the tunnel URL for Slack app configuration
   - Test webhook endpoints
   - Verify App Home functionality

## File Descriptions

### `src/config/index.js`

- Environment variable management
- Configuration validation
- Constants and settings

### `src/services/storage.js`

- Data persistence logic
- GitHub Gist integration
- Storage validation and repair

### `src/handlers/`

- **appHome.js**: App Home tab functionality
- **commands.js**: Slash commands and interactive elements
- **install.js**: OAuth installation and setup
- **messages.js**: DM and conversational interactions
- **webhooks.js**: External webhook endpoints

### `src/utils/`

- **helpers.js**: Common utility functions
- **messageFormatter.js**: Alert message formatting

## Migration from Original App

The original `app.js` is preserved for backward compatibility. To migrate:

1. Test the new modular app: `npm run dev:new`
2. Verify all functionality works
3. Update your deployment to use `app-new.js`
4. Eventually replace `app.js` with the new structure

## Troubleshooting

### Common Issues

1. **Module Import Errors**: Check file paths and exports
2. **Environment Variables**: Ensure `.env` file is properly configured
3. **Debugging Not Working**: Check VS Code launch configuration
4. **Storage Issues**: Verify file permissions and paths

### Debug Commands

```bash
# Check if app is running
curl http://localhost:3000/healthz

# Test webhook endpoint
curl -X POST http://localhost:3000/webhook/test-token \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```
