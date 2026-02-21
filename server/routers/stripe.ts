import { z } from 'zod';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../trpc';
import Stripe from 'stripe';
import { db } from '../db';
import { eq, users, subscriptions } from '../../drizzle/schema';
import { nanoid } from 'nanoid';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-10-22.acacia',
});

export const stripeRouter = createTRPCRouter({
  createCheckoutSession: protectedProcedure
    .input(z.object({ 
      priceId: z.string(), 
    }))
    .mutation(async ({ input, ctx }) => {
      const { userId } = ctx;
      let stripeCustomerId = (await db.query.users.findFirst({ where: eq(users.id, userId) }))?.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          metadata: { userId },
          email: ctx.session.user.email, // assume session has email
        });
        stripeCustomerId = customer.id;
        await db.update(users).set({ stripeCustomerId }).where(eq(users.id, userId));
      }

      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: `${process.env.VITE_OAUTH_PORTAL_URL}/?success=true`,
        cancel_url: `${process.env.VITE_OAUTH_PORTAL_URL}/?canceled=true`,
        subscription_data: {
          trial_period_days: 7, // optional
        },
      });

      return { sessionId: session.id };
    }),

  // Webhook endpoint should be POST /api/trpc/stripe.webhook
  webhook: publicProcedure
    .input(z.any()) // raw body handled in middleware
    .mutation(async ({ ctx, input: rawBody, req }) => {
      const sig = req.headers['stripe-signature'] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
      let event;

      try {
        event = stripe.webhooks.constructEvent(rawBody as string, sig, webhookSecret);
      } catch (err) {
        console.error(err);
        throw new Error('Webhook signature verification failed');
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        // create user if not exists? but protected
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object as Stripe.Subscription;
        const subId = subscription.id;
        const user = await db.query.users.findFirst({
          where: eq(users.stripeCustomerId, subscription.customer as string),
        });
        if (user) {
          await db.upsert(subscriptions).set({
            id: nanoid(),
            userId: user.id,
            stripeSubscriptionId: subId,
            stripePriceId: subscription.items.data[0]?.price.id!,
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            endedAt: subscription.endedAt ? new Date(subscription.endedAt * 1000) : null,
          }).where(eq(subscriptions.stripeSubscriptionId, subId));
        }
      }

      return { received: true };
    }),
});