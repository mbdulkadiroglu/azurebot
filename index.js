const express = require('express');
const http = require('http');
const azdev = require("azure-devops-node-api");
const simpleGit = require("simple-git");
const parseDiff = require('parse-diff');
const {OpenAI} = require('openai');
const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
const personalAccessToken = process.env.AZURE_DEVOPS_TOKEN;

const openai = new OpenAI({
    apiKey: apiKey,
});

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Handle Azure DevOps webhooks
app.post('/api/webhook', (req, res) => {
    const eventType = req.body.eventType;
    console.log('Received event:', eventType);

    // Handle 'pull request created' event
    if (eventType === 'git.pullrequest.created') {
        handlePullRequestCreated(req.body);
    }


    res.status(200).end();
});

// Your event-handling function for pull request created
async function handlePullRequestCreated(payload) {
    const prId = payload.resource.pullRequestId;
    const projectId = payload.resource.repository.project.id;
    const repositoryId = payload.resource.repository.id;
    const organizationUrl = payload.resourceContainers.project.baseUrl;
    const organizationName = organizationUrl.split('/')[3];

    const diffStr = await getDiff(prId, projectId, repositoryId, organizationUrl, organizationName, personalAccessToken);

    const gptResponse = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages:[
            {
                "role" : "system",
                "content" : "Your purpose is to act as a highly experienced software engineer and provide a thorough review of the code hunks and suggest code snippets to improve key areas such as:\n" +
                    "                  - Logic\n" +
                    "                  - Security\n" +
                    "                  - Performance\n" +
                    "                  - Data races\n" +
                    "                  - Consistency\n" +
                    "                  - Error handling\n" +
                    "                  - Maintainability\n" +
                    "                  - Modularity\n" +
                    "                  - Complexity\n" +
                    "                  - Optimization\n" +
                    "                  - Best practices: DRY, SOLID, KISS\n" +
                    "                Do not comment on minor code style issues, missing comments/documentation. Identify " +
                    "                and resolve significant concerns to improve overall code quality while deliberately " +
                    "                disregarding minor issues"
            },
            {
                "role" : "user",
                "content" : diffStr
            }
        ],
        temperature: 0.3,
    });

    const commentContent = gptResponse.choices[0].message.content;
    console.log(commentContent);

    // Initialize Azure DevOps Git API
    const authHandler = azdev.getPersonalAccessTokenHandler(personalAccessToken);
    const connection = new azdev.WebApi(organizationUrl, authHandler);
    const gitApi = await connection.getGitApi();

    // Create comment thread payload
    const commentThreadPayload = {
        comments: [
            {
                parentCommentId: 0,
                content: commentContent,
                commentType: 1, // Indicates a textual comment.
            }
        ],
        status: 1 // Indicates that the thread is active.
    };

    // Post comment thread to pull request
    try {
        await gitApi.createThread(commentThreadPayload, repositoryId, prId, projectId);
        console.log('Comment posted successfully.');
    } catch (e) {
        console.log(`Failed to post comment: ${e}`);
    }

}

// Error-handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).send('Internal Server Error');
});

// Start the server
http.createServer(app).listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    console.log('Press Ctrl + C to quit.');
});

async function getDiff(prId, projectId, repositoryId, organizationUrl, organizationName, personalAccessToken) {
    const authHandler = azdev.getPersonalAccessTokenHandler(personalAccessToken);
    const connection = new azdev.WebApi(organizationUrl, authHandler);

    const gitApiObject = await connection.getGitApi();
    const randomFolderName = Math.floor(Math.random() * 99999999) + 10000000;
    const tempPath = `/tmp/${randomFolderName}`;

    const cloneUrl = `https://${personalAccessToken}@dev.azure.com/${organizationName}/${projectId}/_git/${repositoryId}`;

    const git = simpleGit();
    await git.clone(cloneUrl, tempPath);

    const gitRepo = simpleGit(tempPath);
    const commits = await gitApiObject.getPullRequestCommits(repositoryId, prId, projectId);

    try {
        if (commits.length > 0) {
            const lastCommitOfPullRequest = commits[0].commitId;
            const firstCommitOfPullRequest = commits[commits.length - 1].commitId;

            let diffStr;
            if (lastCommitOfPullRequest === firstCommitOfPullRequest) {
                diffStr = await gitRepo.diff([
                    firstCommitOfPullRequest,
                    "--ignore-all-space",
                    "--pretty=format:",
                ]);
            } else {
                diffStr = await gitRepo.diff([
                    `${firstCommitOfPullRequest}..${lastCommitOfPullRequest}`,
                    "--ignore-all-space",
                    "--pretty=format:",
                ]);
            }

            return diffStr;
        }
    } catch (e) {
        console.log(`Error: ${e}`);
    }

}