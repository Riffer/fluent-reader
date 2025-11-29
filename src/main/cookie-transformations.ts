import { addTransformations } from '@extractus/article-extractor'

/**
 * Initialize cookie banner and consent removal transformations
 * Removes common cookie banners, consent dialogs, and paywalls across websites
 */
export const initializeCookieTransformations = () => {
  // Universal cookie banner removal - applies to all domains
  addTransformations([{
    patterns: [/.*/],
    pre: (document) => {
      // Common cookie/consent banner selectors
      const bannersToRemove = [
        // Cookie banner classes
        '.cookie',
        '.cookie-banner',
        '.cookie-notice',
        '.cookie-consent',
        '.cookie-modal',
        '.cookie-popup',
        
        // GDPR banners
        '.gdpr',
        '.gdpr-banner',
        '.gdpr-cookie',
        '.gdpr-consent',
        '.gdpr-modal',
        
        // Consent/privacy banners
        '.consent',
        '.consent-banner',
        '.consent-cookie',
        '.consent-modal',
        '.consent-popup',
        '.privacy-banner',
        '.privacy-consent',
        '.notice-cookie',
        
        // Attribute selectors
        '[data-cookie]',
        '[data-consent]',
        '[data-gdpr]',
        '[class*="cookie"]',
        '[class*="gdpr"]',
        '[class*="consent"]',
        '[id*="cookie"]',
        '[id*="gdpr"]',
        '[id*="consent"]'
      ]

      bannersToRemove.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach((element) => {
            element.remove()
          })
        } catch (err) {
          // Ignore invalid selectors
        }
      })

      return document
    }
  }])

  // Website-specific transformations
  addTransformations([
    // Medium.com - remove paywall and sign-in prompts
    {
      patterns: [/([\w]+.)?medium\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('.sign-in-prompt').forEach(el => el.remove())
        document.querySelectorAll('.paywall-prompt').forEach(el => el.remove())
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="limited-state"]').forEach(el => el.remove())
        
        // Remove paywall overlay
        const style = document.createElement('style')
        style.innerHTML = 'body { overflow: auto !important; } .paywall { display: none !important; }'
        document.head.appendChild(style)
        
        return document
      }
    },
    
    // LinkedIn - remove sign-in wall and dialogs
    {
      patterns: [/([\w]+.)?linkedin\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="sign-in"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="modal"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="overlay"]').forEach(el => el.remove())
        document.querySelectorAll('.base--hidden').forEach(el => el.remove())
        
        return document
      }
    },
    
    // NY Times - remove subscription wall
    {
      patterns: [/([\w]+.)?nytimes\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="subscription"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="wall"]').forEach(el => el.remove())
        
        // Remove overflow hidden
        const style = document.createElement('style')
        style.innerHTML = 'body { overflow: auto !important; }'
        document.head.appendChild(style)
        
        return document
      }
    },
    
    // Financial Times
    {
      patterns: [/([\w]+.)?ft\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="subscription"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="teaser"]').forEach(el => el.remove())
        
        return document
      }
    },
    
    // Washington Post
    {
      patterns: [/([\w]+.)?washingtonpost\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="metered"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="subscription"]').forEach(el => el.remove())
        
        return document
      }
    },
    
    // Wall Street Journal
    {
      patterns: [/([\w]+.)?wsj\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="subscription"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="offer"]').forEach(el => el.remove())
        
        return document
      }
    },
    
    // Forbes
    {
      patterns: [/([\w]+.)?forbes\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="metered"]').forEach(el => el.remove())
        
        return document
      }
    },
    
    // Wired
    {
      patterns: [/([\w]+.)?wired\.com\/*/],
      pre: (document) => {
        document.querySelectorAll('[class*="paywall"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="subscription"]').forEach(el => el.remove())
        document.querySelectorAll('[class*="signup"]').forEach(el => el.remove())
        
        return document
      }
    }
  ])
}
