# Get Bookking: Claude and ChatGPT directory listings

Copy these into each portal. Claude: claude.ai/directory/manage → Submit new → MCP connector.
ChatGPT: platform.openai.com/plugins → Upload new or existing plugin.

## Shared basics

- **Server URL:** https://getbookking.com/mcp
- **Sign-in:** OAuth 2.0 (sign in with Get Bookking). Supports Claude's published identity (CIMD) and automatic registration (DCR). PKCE S256.
- **Website:** https://getbookking.com
- **Documentation:** https://getbookking.com/ai-assistant
- **Privacy policy:** https://getbookking.com/privacy
- **Terms of service:** https://getbookking.com/terms
- **Support:** https://getbookking.com/contact (email: jilianking@getbookking.com)
- **Company:** Software By King LLC
- **Icon:** crown logo, square PNG (web/marketing/assets/brand/logo-dark-512.png)
- **Brand color:** #2C2018

## Claude listing

- **Name (100 max):** Get Bookking
- **One-liner (200 max):** Ask about your bookings, clients, payments, and client texts, and confirm bookings or text clients with your approval.
- **Categories:** Productivity; Business; Scheduling
- **Description (2,000 max):**

  Get Bookking is booking, payments, and client texting for appointment businesses: salons, tattoo studios, barbers, nail techs, personal trainers, and fishing charters.

  Connect your Get Bookking shop and ask about your business in plain English:
  - "What's on my schedule tomorrow?"
  - "Any new booking requests?"
  - "How much did I take in payments this week?"
  - "Pull up my notes on Jordan."
  - "Any unread texts I need to answer?"

  With actions turned on, Claude can also confirm a booking request, text a client, or send a client a deposit or payment link. Every action shows you a preview first and only happens after you say yes. It can't cancel, refund, or charge a saved card.

  You sign in on getbookking.com, and Claude never sees your password. Choose read-only or actions when you connect, and turn the connection off anytime in Get Bookking under Settings → AI assistant.

  Requires a Get Bookking account (shop owner).

- **Use cases:** daily schedule overview; triaging booking requests; looking up client details and notes; payment summaries; catching up on client texts; confirming bookings and texting clients with approval.
- **What users need:** a Get Bookking shop owner account. Texting and payments need a paid plan.
- **Reads or writes:** both. Write tools always require the owner's explicit yes in the chat.
- **Data handling:** our own API (Get Bookking). No health data. No sponsored content.

## ChatGPT listing

- **Display name (30 max):** Get Bookking
- **Short description (30 max):** Your bookings, clients & texts
- **Developer name:** Software By King LLC
- **Long description (4,000 max):** use the Claude description above, replacing "Claude" with "ChatGPT".
- **Default prompts (3, 128 max each):**
  1. What's on my schedule today?
  2. Do I have any new booking requests?
  3. How much did I take in payments this week?

### Positive test cases (exactly 5)

1. **Today's schedule.** Prompt: "What's on my schedule today?" Tools: get_schedule. Expected: lists today's appointments with times, clients, and services, or says the day is open.
2. **New requests.** Prompt: "Do I have any new booking requests?" Tools: list_booking_requests. Expected: lists waiting requests with client, service, and requested time.
3. **Client lookup.** Prompt: "Pull up notes on test4@example.com." Tools: find_client. Expected: finds the client and shows their contact info and recent notes.
4. **Payments.** Prompt: "How much did I take in payments this month?" Tools: payments_summary. Expected: gives the month's total, amount after fees, and recent payments.
5. **Text a client with approval.** Prompt: "Message test4@example.com asking when they are free this weekend." Tools: text_client. Expected: drafts the text, shows a preview, and asks for approval; only after the user says yes (or taps Send), calls again with the confirm code and reports the text was sent.

### Negative test cases (exactly 3)

1. Prompt: "What's the weather in Miami?" Why not: unrelated to the shop. Expected: answers without calling Get Bookking.
2. Prompt: "Refund Jordan's last payment." Why not: refunds aren't supported. Expected: says it can't refund, and points to the Payments screen in Get Bookking.
3. Prompt: "Text all my clients a 20% off promo." Why not: bulk marketing texts aren't supported, and each text needs approval. Expected: declines bulk sending; offers to text one specific client with a preview.

## Reviewer test account (fill in, enter only in the portals)

- Login URL: https://getbookking.com/login
- Email / password: (demo shop owner account, no 2-step codes)
- Shop: demo shop with sample bookings, clients, payments, and texts
- Steps: add the connector, tap Connect, sign in with the account above, tap Allow (turn on "Can take actions" to test case 5), then run the prompts above.
- Note: texts and payment links from the demo shop go only to test numbers.
