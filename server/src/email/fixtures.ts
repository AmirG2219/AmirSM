/**
 * LOCAL SAMPLE MAILBOX — synthetic messages used until a real mailbox is connected.
 * Everything here is fictional (example.com addresses) and is labelled as sample data in the UI.
 */
export interface FixtureThread {
  subject: string;
  unread: boolean;
  needsReply: boolean;
  messages: { direction: 'in' | 'out'; fromName: string; fromAddr: string; to: string[]; hoursAgo: number; body: string }[];
}

export const SAMPLE_LABEL = 'Sample mailbox — fictional messages';
export const SAMPLE_OWNER_ADDRESS = 'owner@sample.example.com';

export const FIXTURE_THREADS: FixtureThread[] = [
  {
    subject: 'Collab idea: sunrise routine series',
    unread: true,
    needsReply: true,
    messages: [
      {
        direction: 'in', fromName: 'Sample Brand Team', fromAddr: 'partnerships@brand.example.com', to: [SAMPLE_OWNER_ADDRESS], hoursAgo: 5,
        body: 'Hi,\n\nWe like your calm morning-routine videos and would love to explore a short series together. Could you share your usual rates and availability for the next month?\n\nThanks,\nSample Brand Team',
      },
    ],
  },
  {
    subject: 'Invoice 1042 — editing music licence',
    unread: false,
    needsReply: false,
    messages: [
      {
        direction: 'in', fromName: 'Sample Music Library', fromAddr: 'billing@music.example.com', to: [SAMPLE_OWNER_ADDRESS], hoursAgo: 52,
        body: 'Your licence invoice 1042 is attached. Payment is due within 14 days. No action is needed if you have already paid.',
      },
    ],
  },
  {
    subject: 'Re: Photo shoot on Saturday?',
    unread: true,
    needsReply: true,
    messages: [
      { direction: 'out', fromName: 'You (sample)', fromAddr: SAMPLE_OWNER_ADDRESS, to: ['sam@friend.example.com'], hoursAgo: 30, body: 'Are you free Saturday morning for a few shots by the river? Around 8am for the light.' },
      { direction: 'in', fromName: 'Sam (sample)', fromAddr: 'sam@friend.example.com', to: [SAMPLE_OWNER_ADDRESS], hoursAgo: 3, body: 'Saturday works! 8am is a bit early for me — could we do 9 instead? Also, should I bring the second camera?' },
    ],
  },
  {
    subject: 'Reminder: creator newsletter draft due Friday',
    unread: false,
    needsReply: false,
    messages: [
      { direction: 'in', fromName: 'Sample Newsletter Editor', fromAddr: 'editor@news.example.com', to: [SAMPLE_OWNER_ADDRESS], hoursAgo: 80, body: 'Quick reminder that the draft for the creator newsletter is due Friday. Aim for around 400 words about your editing workflow.' },
    ],
  },
];
