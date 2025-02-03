require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');  // For scheduling the summary
const app = express();
const JiraClient = require('jira-client');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'channels.json');

const PORT = process.env.PORT || 3000;

const processedTimestamps = new Set();
const mentions = [];  // To store mentions for the daily summary

app.use(bodyParser.json());

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
// Initialize Jira client
const jira = new JiraClient({
    protocol: 'https',
    host: process.env.JIRA_HOST,
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN
});

let mentionTracker = [];

const teamMembers = [
    'U05RH3FBPTQ', // Ravindra Singh Rathore
    'U07PVEA7J5A', // Vivek Patwari
    'ULUGFQTC2',   // Paras Jain
    'U06MR2TUSJY', // Abhi
    'U041G2SCBQS', // Pramod Mishra
    'U07A1UKJA30', // Bharath Raja
    'U07GKDFDHL5'  // Hetal Panchal
];

// Middleware to parse incoming JSON payloads
app.post('/slack/events', async (req, res) => {
    const body = req.body;

    if (body.type === 'url_verification') {
        return res.status(200).send({ challenge: body.challenge });
    }

    if (body.type === 'event_callback') {
        const event = body.event;

        if (!event.text) {
            return res.status(400).send('Empty text');
        }

        if (event.type === 'message' && event.text.includes('<@U07LBM3N0Q1>') && event.thread_ts && event.text.includes('create ticket')) {
            const channelId = event.channel;
            const user = event.user;
            const timestamp = event.ts;
            const threadTimestamp = event.thread_ts; // Use the thread timestamp here.

            try {
                // Fetch thread messages
                const threadMessages = await getThread(channelId, threadTimestamp); // Use the thread_ts for fetching

                // Create Jira ticket
                await createJiraTicket(channelId, user, event.text, threadMessages, timestamp, threadTimestamp);

                res.status(200).send();
            } catch (error) {
                res.status(500).send('Error processing event');
            }
        } else {
            res.status(200).send();
        }
    } else {
        res.status(400).send('Invalid request');
    }
});

async function getThread(channelId, threadTs) {
    try {
        const threadMessages = [];

        // Step 1: Fetch the parent message explicitly (using thread_ts)
        const parentResponse = await slack.conversations.history({
            channel: channelId,
            latest: threadTs,
            inclusive: true,
            limit: 1,
        });

        if (parentResponse.ok && parentResponse.messages && parentResponse.messages.length > 0) {
            threadMessages.push(parentResponse.messages[0]); // Add parent message to the thread
        } else {
            console.warn("Parent message not found or accessible.");
        }

        // Step 2: Fetch all replies in the thread (correcting logic for replies)
        let hasMore = true;
        let cursor = null;

        while (hasMore) {
            const repliesResponse = await slack.conversations.replies({
                channel: channelId,
                ts: threadTs, // Use thread timestamp correctly
                cursor: cursor,
            });

            if (repliesResponse.ok && repliesResponse.messages) {
                threadMessages.push(...repliesResponse.messages); // Add replies to the thread
            }

            hasMore = repliesResponse.has_more || false;
            cursor = repliesResponse.response_metadata?.next_cursor || null;
        }

        return threadMessages;
    } catch (error) {
        console.error('Error fetching thread:', error);
        throw error;
    }
}

async function ensureBotInChannel(channelId, isArchived) {
    if (isArchived) return; // Skip archived channels

    try {
        // Check if the bot is a member of the channel
        const channelInfo = await slack.conversations.info({ channel: channelId });

        // If the bot is not a member, join the channel
        if (!channelInfo.channel.is_member) {
            console.log(`Bot is not in channel ${channelId}, attempting to join...`);
            try {
                await slack.conversations.join({ channel: channelId });
                console.log(`Successfully joined channel ${channelId}`);
            } catch (err) {
                console.error(`Error joining channel ${channelId}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`Error checking channel info for ${channelId}:`, err.message);
    }
}

function writeChannelsToFile(channels) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(channels, null, 2));
        console.log('✅ Channels saved successfully!');
    } catch (error) {
        console.error('❌ Error writing channels to file:', error);
    }
}

function readChannelsFromFile() {
    try {
        if (!fs.existsSync(filePath)) return []; // Return empty list if file doesn't exist
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ Error reading channels from file:', error);
        return [];
    }
}

async function fetchAllChannelsWithTeamMembers() {
    let channels = [];
    let cursor = null;
    let channelCount = 0; // To track total channels processed
    let teamMemberCount = 0; // To track channels with team members

    try {
        // Fetch all channels in the workspace
        do {
            const result = await slack.conversations.list({
                token: process.env.SLACK_BOT_TOKEN,              // Use the bot token
                limit: 100,                                      // Fetch 100 channels per request
                cursor: cursor,                                  // Pagination cursor for next batch
                types: "public_channel,private_channel"          // Include both public and private channels
            });

            if (result.channels) {
                for (const channel of result.channels) {
                    channelCount++; // Increment total channel count
                    console.log(`Total Channels Processed: ${channelCount}`);
                    // Skip archived channels
                    if (channel.is_archived) {
                        continue;
                    }

                    // Fetch channel members
                    const membersResult = await slack.conversations.members({
                        channel: channel.id
                    });

                    // console.log("membersResult.members", membersResult.members);

                    // Check if the bot is already a member of the channel
                    const botIsMember = membersResult.members.includes(process.env.BOT_USER_ID);
                    if (botIsMember) {
                        console.log(`Bot is already a member of the channel: ${channel.name}`);
                    } else {
                        // If bot is not a member, join the channel
                        try {
                            await slack.conversations.join({ channel: channel.id });
                            console.log(`Bot added to the channel: ${channel.name}`);
                        } catch (err) {
                            console.error(`Error joining channel ${channel.name}:`, err.message);
                            continue;
                        }
                    }

                    // Check if any of your team members are in this channel
                    const teamMembersInChannel = membersResult.members.filter(member =>
                        teamMembers.includes(member) // Assuming `teamMembers` is an array of team member IDs
                    );

                    // If any team member is in the channel, add it to the list
                    if (teamMembersInChannel.length > 0) {
                        teamMemberCount++; // Increment team member count for this channel
                        console.log(`Channels with Team Members: ${teamMemberCount}`);
                        channels.push(channel.id);
                    }
                }
            }

            cursor = result.response_metadata?.next_cursor || null; // Move to the next page if available
            console.log("channels", channels);
        } while (cursor); // Continue until there are no more pages

        console.log(`✅ Fetched ${channels.length} channels with team members`);


        return channels;
    } catch (error) {
        console.error('❌ Error fetching channels with team members:', error);
        return [];
    }
}

async function initializeBotChannels() {
    let channels = readChannelsFromFile(); // Get existing channels

    if (channels.length === 0) {
        console.log('Fetching all channels with team members from Slack...');
        channels = await fetchAllChannelsWithTeamMembers(); // Fetch only channels with team members
        writeChannelsToFile(channels); // Save them to file
    }

    console.log(`Bot initialized in ${channels.length} channels`);
}


initializeBotChannels()


async function trackMentions() {
    const mentionTracker = {};
    const teamChannels = readChannelsFromFile(); // Read saved channels

    const oneDayAgo = moment().subtract(24, 'hours').unix();

    for (const channelId of teamChannels) {
        try {
            const messages = await slack.conversations.history({
                channel: channelId,
                oldest: oneDayAgo,
                limit: 100,
            });

            for (const message of messages.messages) {
                const mentionedUsers = teamMembers.filter(member => message.text.includes(`<@${member}>`));
                mentionedUsers.forEach(userId => {
                    if (!mentionTracker[userId]) mentionTracker[userId] = [];

                    if (message.thread_ts) {
                        const threadLink = `https://yourworkspace.slack.com/archives/${channelId}/p${message.thread_ts.replace('.', '')}`;
                        mentionTracker[userId].push(threadLink);
                    }
                });
            }
        } catch (error) {
            console.error(`Error fetching messages for channel ${channelId}:`, error);
        }
    }

    return mentionTracker;
}

async function updateChannels() {
    let channels = readChannelsFromFile();

    const result = await slack.conversations.list();
    for (const channel of result.channels) {
        if (!channels.includes(channel.id) && !channel.is_archived) {
            try {
                await slack.conversations.join({ channel: channel.id });
                channels.push(channel.id);
                console.log(`Joined new channel: ${channel.name}`);
            } catch (err) {
                console.error(`Error joining channel ${channel.name}:`, err.message);
            }
        }
    }

    writeChannelsToFile(channels); // Save updated list
}

async function removeInactiveChannels() {
    let channels = readChannelsFromFile(); // Read saved channels
    let activeChannels = [];

    for (const channelId of channels) {
        try {
            // Get members in the channel
            const result = await slack.conversations.members({ channel: channelId });
            const channelMembers = result.members;

            // Check if at least one team member is still in the channel
            const hasTeamMember = teamMembers.some(member => channelMembers.includes(member));

            if (hasTeamMember) {
                activeChannels.push(channelId);
            } else {
                console.log(`Removing inactive channel: ${channelId}`);
            }
        } catch (error) {
            console.error(`Error checking members for channel ${channelId}:`, error);
        }
    }

    writeChannelsToFile(activeChannels); // Save updated list
}


async function sendMentionSummary(mentions) {
    try {
        if (!mentions || Object.keys(mentions).length === 0) {
            return;
        }

        // Format the summary
        let summary = '*Tracked Mentions (Last 24 Hours):*\n';
        for (const [userId, threads] of Object.entries(mentions)) {
            summary += `<@${userId}>\n`;
            threads.forEach((thread, index) => {
                summary += `    ${index + 1}. <${thread}|View Thread>\n`; // Link to the thread
            });
        }

        // Send the summary to a private channel
        await slack.chat.postMessage({
            channel: process.env.SLACK_PRIVATE_CHANNEL_ID, // Replace with your private channel ID
            text: summary,
        });

    } catch (error) {
        console.error('Error sending mention summary:', error);
    }
}

const userMappings = {
    U12345: "user1@example.com", // Replace with Slack user ID and Jira email
    U67890: "user2@example.com",
    U11223: "user3@example.com",
    U44556: "user4@example.com",
    U77889: "user5@example.com",
    U99001: "user6@example.com",
};

const teamEmails = [
    'abhishekmishra1@gofynd.com',
];

teamEmails.forEach(async (email) => {
    const tickets = await fetchJiraTicketsForDXBoard(email);
    console.log(`Tickets for ${email}:`, tickets);
});


async function fetchJiraTicketsForDXBoard(userEmail) {
    try {
        const jiraBaseURL = process.env.JIRA_HOST; // Ensure this is correctly set
        console.log('JIRA Base URL:', jiraBaseURL); // Debug log
        if (!jiraBaseURL) throw new Error('JIRA_HOST is not defined.');

        const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

        // JQL to filter DX board tickets
        const jql = `project = "DX" AND assignee = "${userEmail}"`;

        const response = await axios.get(`${jiraBaseURL}/rest/api/2/search`, {
            headers: {
                Authorization: `Basic ${jiraAuth}`,
                'Content-Type': 'application/json',
            },
            params: { jql, fields: 'key,summary' },
        });

        // Map Jira issues to a simplified structure
        return response.data.issues.map(issue => ({
            key: issue.key,
            summary: issue.fields.summary,
            url: `${jiraBaseURL}/browse/${issue.key}`,  // Add ticket URL
        }));
    } catch (error) {
        console.error(`Error fetching Jira tickets for ${userEmail}:`, error.message); // Improved error message
        return [];
    }
}


async function sendDXBoardSummary() {
    try {
        const teamEmails = [
            'abhishekmishra1@gofynd.com',
        ];

        let summary = '*DX Board Tickets (In Progress):*\n';

        for (const email of teamEmails) {
            const tickets = await fetchJiraTicketsForDXBoard(email);

            summary += `<@${email}>:\n`;
            if (tickets.length > 0) {
                tickets.forEach((ticket, index) => {
                    summary += `    ${index + 1}. *${ticket.key}*: ${ticket.summary} - <${ticket.url}|Link>\n`; // Add link
                });
            } else {
                summary += '    No tickets in progress.\n';
            }
        }

        // Send to Slack
        await slack.chat.postMessage({
            channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
            text: summary,
        });

        console.log('DX board summary sent successfully.');
    } catch (error) {
        console.error('Error sending DX board summary:', error);
    }
}


// Schedule the task to run daily
cron.schedule('22 14 * * *', async () => {
    try {

        console.log('Running DX board summary task...');
        await updateChannels();         // Add new channels
        await removeInactiveChannels(); // Remove channels with no team members
        const mentions = await trackMentions(); // Track mentions only in active channels
        console.log('Mention tracker after tracking:', mentions);
        await sendMentionSummary(mentions);
        await sendDXBoardSummary();
    } catch (error) {
        console.error('Error in scheduled Jira task:', error);
    }
});


// cron.schedule('32 18 * * *', async () => {
//     //console.log('Running scheduled task...');
//     try {
// const mentions = await trackMentions(); // Fetch mentions
// //console.log('Mention tracker after tracking:', mentions);
// await sendMentionSummary(mentions);
//     } catch (error) {
//         //console.error('Error in scheduled task:', error);
//     }
// });

async function createJiraTicket(channelId, user, messageText, threadMessages, timestamp, threadTs) {
    // Check if the statement has already been processed (avoiding duplicates by timestamp)
    //console.log("Checking timestamp:", timestamp);

    if (processedTimestamps.has(timestamp)) {
        //console.log(`Ticket already created for message with timestamp: ${timestamp}`);
        return; // Prevent duplicate ticket creation
    }

    processedTimestamps.add(timestamp);

    try {
        console.log("threadMessages and messageText", threadMessages, messageText);
        const description = await generateJiraDescription(threadMessages, messageText);

        console.log("Jira description", description);

        const permalinkResponse = await slack.chat.getPermalink({
            channel: channelId,
            message_ts: threadTs,
        });

        if (!permalinkResponse.ok) {
            throw new Error('Failed to fetch thread permalink');
        }

        const threadPermalink = permalinkResponse.permalink;

        const descriptionWithLink = `${description}\n\nSlack Thread: ${threadPermalink}`;

        const issue = await jira.addNewIssue({
            fields: {
                project: { key: 'DX' },
                summary: `Ticket created for message from ${user}`,
                description: descriptionWithLink,
                issuetype: { name: 'Task' },
            },
        });

        const jiraTicketLink = `https://${process.env.JIRA_HOST}/browse/${issue.key}`;

        await slack.chat.postMessage({
            channel: channelId,
            text: `Jira ticket created: <${jiraTicketLink}|${issue.key}>`,
            thread_ts: threadTs, // Post in the thread
        });
    } catch (error) {
        await slack.chat.postMessage({
            channel: channelId,
            text: 'Failed to create Jira ticket. Please try again later.',
            thread_ts: threadTs, // Post in the thread
        });
    }
}

async function generateJiraDescription(threadMessages, messageText) {
    const threadContext = threadMessages.map(m => m.text).join('\n');

    console.log("threadContext", threadContext);
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: `Here is the context from a Slack thread:\n\n${threadContext}\n\nYour task is to analyze the entire thread context and create a detailed description based only on the issue or discussion presented in the messages. Do not include any mention of the action to create a ticket or replies that ask for ticket creation. Focus solely on the core issue or context being discussed. Ensure the description is accurate, complete, and written as a professional explanation, excluding any extraneous details or actions related to ticket creation.` }
                ],
                max_tokens: 1000,
            },
            {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            }
        );

        console.log("response", response);

        const messageContent = response.data.choices[0]?.message?.content;
        if (messageContent) {
            return messageContent.trim();
        } else {
            return 'Failed to generate description via AI.';
        }
    } catch (error) {
        return 'Failed to generate description via AI.';
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});