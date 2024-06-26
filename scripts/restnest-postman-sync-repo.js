/**
 * DEV Setup: Prepares restnest-postman environments global variables for ./newman/restnest-postman-sync-*.js,
 *  REQUIRED: postman_api_key_admin_local - see restnest-postman/environments/restnest-secrets.postman_globals.json
 * On initial setup, ./newman/restnest-postman-prep-repo.js creates initial Postman Repo workspace, e.g. restnest-postman-domain
 * Otherwise, ./newman/restnest-postman-sync-*.js scripts download all Postman Repo workspace collections and environments
 */
const { resolve } = require('path');
const fs = require('fs');
const prompt = require('prompt-sync')();
const { getGCPSecret } = require('../openapi/postman/scripts/gcp/postmanApiKeyCheck');
const {
  getAllLocalSecrets,
  getLocalSecret,
  writeLocalSecret,
} = require('../openapi/postman/scripts/local/secrets');
const util = require('node:util');
const exec = util.promisify(require('node:child_process').exec);
const { program } = require('commander');

// Check for program parameters
program
  .option(
    '-c, --cloudSecretId <cloudSecretId>',
    'Cloud Key Secret Manager, GCP Project Id, Azure KeyVault'
  )
  .option(
    '-g, --gitFeatureOverride <gitFeatureOverride>',
    'Git Origin, e.g. 123456/bla-bla, refresh/main'
  )
  .parse(process.argv);
const options = program.opts();
const cloudSecretsId = options.cloudSecretId || '';
const gitFeatureOverride = options.gitFeatureOverride || '';

// Prep globals/secerts for upcoming Newman collection runs 
const environmentDir = resolve(__dirname, '../restnest-postman/environments');
const globalsBasePath = resolve(environmentDir, 'restnest-postman.postman_globals.base.json');
const globalsMainPath = resolve(environmentDir, 'restnest-postman.postman_globals.main.json');
const globalsPath = resolve(environmentDir, 'restnest-postman.postman_globals.json');
const globalsSecretsBasePath = resolve(
  environmentDir,
  'restnest-secrets.postman_globals.base.json'
);
const globalsSecretsPath = resolve(environmentDir, 'restnest-secrets.postman_globals.json');

/**
 * Prepares globals for collection/environments setup/lookup from Postman Repo (see WorkspaceSync collection, etc.)
 * NOTE: Gets postman_apikey from locally managed secrets - see restnest-postman/environments/restnest-secrets.postman_globals.json
 * OPTION: GCP, Azure or other cloud secret manager - see example in scripts/gcp/postmanApiKeyCheck.js
 *  - set isUsingCloudForSecrets to true to activate Google Cloud Secret Lookup
 */
async function prepPostmanSync(globalsBasePath, globalsPath, gitRepoName, taskNr) {
  const isUsingCloudForSecrets = false; // Change according to need /

  // Get Postman Api Key for developer - prompt if required
  let postman_api_key_developer = '';
  const isMain = taskNr === 'main';
  const isDeveloper = !isMain;
  try {
    // Developer run - tasknr from feature branch detected above, e.g. feature/123456/this-branch
    if (isDeveloper) {
      console.log(
        `\n ✅ -> Preparing for Postman Sync with git repo ${gitRepoName}, feature task ${taskNr} ...`
      );

      // Check globals state - set values from previous run, unless main, then re-prompt
      let isMainRunDetected = false;
      let isDevRunDetected = false;
      try {
        isMainRunDetected = fs.statSync(globalsMainPath).isFile();
      } catch {}
      try {
        isDevRunDetected = fs.statSync(globalsPath).isFile();
      } catch {}
      if (isDevRunDetected && !isMainRunDetected) {
        const globalsOld = JSON.parse(fs.readFileSync(globalsPath, { encoding: 'UTF8' }));
        postman_api_key_developer = (
          globalsOld.values.find(
            global => global.key === 'postman-api-key-developer' && !global.value.startsWith('<')
          ) || {
            value: '',
          }
        ).value;
      } else if (isMainRunDetected) {
        fs.unlinkSync(globalsMainPath);
      }

      // Prompt for api key if not found
      if (!postman_api_key_developer) {
        console.log(
          '\n ✅ -> Postman API Key required - see https://*.postman.co/settings/me/api-keys'
        );
        postman_api_key_developer = prompt('Please enter your Postman API Key:');
        if (!postman_api_key_developer) {
          throw new Error('Developer Postman API Key is required');
        }
      }

      // Main run (test) - usually only main run in pipleine (set marker to avoid reuse of admin key in developer run)
    } else if (isMain) {
      fs.copyFileSync(globalsBasePath, globalsMainPath);
    }
  } catch (err) {
    console.error('Error setting postman_api_key:', err);
    process.exit(1);
  }

  // Prepare globals for synchronization/augmentation run
  try {
    // Copy globals.base to globals
    fs.copyFileSync(globalsBasePath, globalsPath);
    const globals = require(globalsPath);

    // Get locally managed secrets
    let globalSecrets;
    let postman_api_key_admin = '';
    const isPrompting = taskNr !== 'main';
    try {
      globalSecrets = getAllLocalSecrets(
        globalsSecretsBasePath,
        globalsSecretsPath,
        isUsingCloudForSecrets,
        isPrompting
      );
      // Lookup secret in cloud and save locally
      if (isUsingCloudForSecrets) {
        postman_api_key_admin = await getGCPSecret('postman_apikey', cloudSecretsId);
        writeLocalSecret(
          globalsSecretsPath,
          globalSecrets,
          'postman-api-key-admin-local',
          postman_api_key_admin
        );
        // Get locally-managed secret for LOCAL USE ONLY
      } else {
        postman_api_key_admin = getLocalSecret(globalSecrets, 'postman-api-key-admin-local');
      }
      if (!postman_api_key_admin) {
        throw new Error('postman_api_key_admin missing');
      }
    } catch (err) {
      console.error(`Error getting secrets for Postman API`, err);
      fillGlobal(globals, postman_api_key_admin, postman_api_key_developer, gitRepoName, taskNr);
      process.exit(1);
    }

    // Check if main, and set postman-api-key-developer to admin
    if (isMain) {
      postman_api_key_developer = postman_api_key_admin;
    }

    // Set & write globals
    fillGlobal(globals, postman_api_key_admin, postman_api_key_developer, gitRepoName, taskNr);
  } catch (err) {
    console.error('Error updating globals for synchronization/augmentation run:', err);
    process.exit(1);
  }

  // helpers
  // Set & write globals
  function fillGlobal(
    globals,
    postman_api_key_admin,
    postman_api_key_developer,
    gitRepoName,
    taskNr
  ) {
    const isAdmin = postman_api_key_developer === postman_api_key_admin;
    globals.values.forEach(global => {
      if (global.key === 'cloud-secrets-id') {
        global.value = cloudSecretsId;
      } else if (global.key === 'postman-api-key') {
        global.value = isAdmin ? postman_api_key_admin : postman_api_key_developer;
      } else if (global.key === 'postman-api-key-admin') {
        global.value = postman_api_key_admin;
      } else if (global.key === 'postman-api-key-developer') {
        global.value = postman_api_key_developer;
      } else if (global.key === 'e2e_git_repo_name') {
        global.value = gitRepoName;
      } else if (global.key === 'e2e_git_repo_feature_task') {
        global.value = taskNr;
      } else if (global.key === 'repo_workspace_name') {
        const postmanRepoName = gitRepoName.replace('restnest-openapi-', 'restnest-postman-');
        const postmanRepoNameSplit = postmanRepoName.split('-');
        if (postmanRepoNameSplit.length !== 3) {
          throw new Error(
            'Postman Repo name does not conform to naming standard: restnest-openapi-domain'
          );
        } else if (global.value.startsWith('<')) {
          global.value = postmanRepoName;
        }
      }
    });
    fs.writeFileSync(globalsPath, JSON.stringify(globals, null, 2));
    // Make sure we got the api key, and report repo status
    if (postman_api_key_admin) {
      const workspaceName = (
        globals.values.find(global => global.key === 'repo_workspace_name') || { value: '' }
      ).value;
      const workspaceId = (
        globals.values.find(global => global.key === 'repo_workspace_id') || { value: '' }
      ).value;
      if (!workspaceName || !workspaceId) {
        throw new Error(
          'Could not prep for workspace sync due to missing global variables repo_workspace_name / repo_workspace_id'
        );
      }
      const isOpenApiPrep = workspaceName.startsWith('<') || workspaceId.startsWith('<');
      if (isOpenApiPrep) {
        console.log(
          `\n ✅ -> Prepared for Postman OpenApi workspace sync with new repo ${workspaceName}.\n`
        );
      } else {
        console.log(`\n ✅ -> Prepared for sync from Postman repo workspace ${workspaceName}.\n`);
      }
    }
  }
}

async function main() {
  const gitOrigin = await getGitOrigin();
  const gitFeature = gitFeatureOverride ? gitFeatureOverride : await getGitFeature();

  // Check Repo for pre-requisites and fail if not met
  if (!(gitOrigin && gitFeature)) {
    console.error('Current repository does not have a remote origin and/or is not feature branch.');
    process.exit(1);
  }
  // Expect RESTNEST instance git repo name to be format: restnest-openapi-*
  // Forks from git repo in format: restnest-openapi-*.*, e.g. restnest-openapi-instance.me (.* ignored)
  const gitOriginSplit = gitOrigin.replace('.git', '').split('/');
  const gitRepoName = gitOriginSplit[gitOriginSplit.length - 1].split('.')[0];
  if (!gitRepoName.startsWith('restnest-openapi-')) {
    console.error(
      `GIT_ORIGIN repo name ${gitRepoName} does not conform - expected forked restnest-openapi-[domainName]`
    );
    process.exit(1);
  }
  const taskNrSplit = gitFeature.replace('-', '/').split('/');
  const taskNr =
    taskNrSplit.length > 1
      ? Number.isNaN(parseInt(taskNrSplit[0]))
        ? Number.isNaN(parseInt(taskNrSplit[1]))
          ? gitFeature === 'refresh/main'
            ? taskNrSplit[1]
            : ''
          : taskNrSplit[1]
        : taskNrSplit[0]
      : '';
  if (!taskNr) {
    console.error(
      `GIT_FEATURE env variable value ${gitFeature} unexpected  - expected, e.g. 123456/this-branch, bla/123456/this-branch or refresh/main.`
    );
    process.exit(1);
  }

  prepPostmanSync(globalsBasePath, globalsPath, gitRepoName, taskNr);

  // helpers
  async function getGitOrigin() {
    return await execString('git config --get remote.origin.url');
  }
  async function getGitFeature() {
    return await execString('git symbolic-ref --short HEAD');
  }
  async function execString(cmd) {
    const { stdout, stderr } = await exec(cmd);
    if (stderr) {
      console.error('stderr:', stderr);
    }
    return stdout?.replace(/\r?\n|\r/, '');
  }
}
main();
