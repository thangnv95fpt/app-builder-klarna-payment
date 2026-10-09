import React from 'react'
import { 
  Provider,
  defaultTheme,
  View, 
  Form, 
  TextField, 
  ButtonGroup, 
  Button,
  Text,
  ProgressCircle, Flex } from '@adobe/react-spectrum'
import allActions from '../config.json'
import actionWebInvoke from '../utils'
import { GraphQLClient } from "graphql-request";

const KLARNA_SDK_URL = 'https://x.klarnacdn.net/kp/lib/v1/api.js'
const KLARNA_CONTAINER_ID = 'klarna-payments-container'

// Step 1a: load the Klarna SDK script once and resolve when window.Klarna is ready
function loadKlarnaSdk() {
  return new Promise((resolve, reject) => {
    if (window.Klarna && window.Klarna.Payments) {
      resolve(window.Klarna)
      return
    }
    window.klarnaAsyncCallback = () => resolve(window.Klarna)
    if (!document.querySelector(`script[src="${KLARNA_SDK_URL}"]`)) {
      const script = document.createElement('script')
      script.src = KLARNA_SDK_URL
      script.async = true
      script.onerror = () => reject(new Error('Failed to load Klarna SDK'))
      document.body.appendChild(script)
    }
  })
}
const renderLoading = function (isLoading = false) {
    return isLoading?
        <Flex position="fixed" UNSAFE_style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.25)',
            zIndex: 9999
        }}>
            <ProgressCircle size="L" aria-label="Loading…" isIndeterminate/>
        </Flex> : <></>

}
function App() {
  let [maskCartId, setMaskCartId] = React.useState('')
  let [authToken, setAuthToken] = React.useState('')
  let [message, setMessage] = React.useState('')
  let [isLoading, setIsLoading] = React.useState(false)

  // Step 1: Initialize the SDK with the client_token of the session
  // Step 2: Display Klarna in the container
  let onSubmit = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    setMessage('')
    setAuthToken('')
    const klarnaSession = await actionWebInvoke(allActions['klarna/create-klarna-session'], {}, { maskCartID: maskCartId })
    if (klarnaSession.clientToken === undefined) {
      alert('Failed to create Klarna session')
      setIsLoading(false)
      return
    }

    try {
      const Klarna = await loadKlarnaSdk()
      Klarna.Payments.init({ client_token: klarnaSession.clientToken })
      Klarna.Payments.load({ container: `#${KLARNA_CONTAINER_ID}` }, {}, (res) => {
        console.debug('Klarna load', res)
        if (res.show_form) {
          window.Klarna.Payments.authorize({}, {}, onAuthorizationCallback)
        } else {
          setMessage('Klarna is not available for this cart')
          setIsLoading(false)
        }
      })
    } catch (err) {
      setMessage(err.message)
      setIsLoading(false)
    }
  }

  // Step 3: Authorization callback
  let onAuthorizationCallback = async (res) => {
    console.debug('Klarna authorize', res)
    if (res.approved && res.authorization_token) {
      // Valid for 60 minutes; use it to create the order server-side
      setAuthToken(res.authorization_token)
      setMessage('Klarna authorization approved')

      // Validate the quote first: skip placing the order if it was already placed by the authorization callback
      try {
        setIsLoading(true)
        console.debug('Checking quote status for authorization token:', res.authorization_token)
        const quoteStatus = await actionWebInvoke(allActions['klarna/quote-status'], {}, { authorization_token: res.authorization_token })
        if (quoteStatus.is_active !== '1') {
          setMessage('Order has already been placed')
          setIsLoading(false)
          return
        }
        if (!quoteStatus.is_successful) {
          setMessage('The transaction is not authorized')
          setIsLoading(false)
          return
        }
      } catch (error) {
        console.error('Error checking quote status:', error)
        setMessage('Unable to validate the quote, please try again')
        setIsLoading(false)
        return
      }

      return;

      const commerceClient = new GraphQLClient("https://na1-sandbox.api.commerce.adobe.com/GHdCg8JTQUHx5VpHeUVbJK/graphql");
      const mutation = `
      mutation placeOrder($maskCartId: String!) {
        placeOrder(input: { cart_id: $maskCartId}) {
          orderV2 {
            email
          }
        }
      }
    `;

    try {
      await commerceClient.request(
        mutation,
        { maskCartId }
      );

      setMessage('Place Order success');
      setIsLoading(false)
    } catch (error) {
      console.error('Error placing order:', error)
    }
    } else if (res.show_form) {
      // Not approved but fixable: Klarna shows the invalid fields to the customer
      const fields = res.error && res.error.invalid_fields
      setMessage(fields && fields.length ? `Please fix: ${fields.join(', ')}` : 'Authorization was not approved, please try again')
      setIsLoading(false)
    } else {
      // Klarna is no longer available: hide it and fall back to another payment method
      setKlarnaReady(false)
      setMessage('Klarna is not available, please choose another payment method')
      setIsLoading(false)
    }
  }

  return (
    <Provider theme={defaultTheme} colorScheme={'light'}>
      <View>
        {renderLoading(isLoading)}
        <Form onSubmit={onSubmit} maxWidth="size-3000">
          <TextField label="Mask Cart ID" value={maskCartId} onChange={setMaskCartId} />
          <ButtonGroup>
            <Button type="submit" variant="primary">Place Order</Button>
          </ButtonGroup>
        </Form>
        <div id={KLARNA_CONTAINER_ID}></div>
        {message && <Text>{message}</Text>}
        {authToken && <Text>Authorization token: {authToken}</Text>}
      </View>
    </Provider>
  )
}

export default App
