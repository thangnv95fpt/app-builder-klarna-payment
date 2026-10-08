import React from 'react'
import { Provider, defaultTheme, View, Form, TextField, ButtonGroup, Button, Text } from '@adobe/react-spectrum'
import allActions from '../config.json'
import actionWebInvoke from '../utils'

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

function App() {
  let [maskCartId, setMaskCartId] = React.useState('')
  let [klarnaReady, setKlarnaReady] = React.useState(false)
  let [authToken, setAuthToken] = React.useState('')
  let [message, setMessage] = React.useState('')

  // Step 1: Initialize the SDK with the client_token of the session
  // Step 2: Display Klarna in the container
  let onSubmit = async (e) => {
    e.preventDefault()
    setMessage('')
    setAuthToken('')
    const klarnaSession = await actionWebInvoke(allActions['klarna/create-klarna-session'], {}, { maskCartID: maskCartId })
    if (klarnaSession.clientToken === undefined) {
      alert('Failed to create Klarna session')
      return
    }

    try {
      const Klarna = await loadKlarnaSdk()
      Klarna.Payments.init({ client_token: klarnaSession.clientToken })
      Klarna.Payments.load({ container: `#${KLARNA_CONTAINER_ID}` }, {}, (res) => {
        console.debug('Klarna load', res)
        if (res.show_form) {
          setKlarnaReady(true)
        } else {
          setKlarnaReady(false)
          setMessage('Klarna is not available for this cart')
        }
      })
    } catch (err) {
      setMessage(err.message)
    }
  }

  // Step 3: Get authorization when the customer confirms payment
  let onAuthorize = () => {
    // TODO: replace with real customer data from the cart / checkout form
    const orderData = {
      billing_address: {
        given_name: 'Alice',
        family_name: 'Test',
        email: 'customer@email.se',
        phone: '+46701740615',
        street_address: 'Södra Blasieholmshamnen 2',
        postal_code: '11 148',
        city: 'Stockholm',
        country: 'SE'
      }
    }
    window.Klarna.Payments.authorize({}, orderData, onAuthorizationCallback)
  }

  // Step 4: Authorization callback
  let onAuthorizationCallback = (res) => {
    console.debug('Klarna authorize', res)
    if (res.approved && res.authorization_token) {
      // Valid for 60 minutes; use it to create the order server-side
      setAuthToken(res.authorization_token)
      setMessage('Klarna authorization approved')
    } else if (res.show_form) {
      // Not approved but fixable: Klarna shows the invalid fields to the customer
      const fields = res.error && res.error.invalid_fields
      setMessage(fields && fields.length ? `Please fix: ${fields.join(', ')}` : 'Authorization was not approved, please try again')
    } else {
      // Klarna is no longer available: hide it and fall back to another payment method
      setKlarnaReady(false)
      setMessage('Klarna is not available, please choose another payment method')
    }
  }

  return (
    <Provider theme={defaultTheme} colorScheme={'light'}>
      <View>
        <Form onSubmit={onSubmit} maxWidth="size-3000">
          <TextField label="Mask Cart ID" value={maskCartId} onChange={setMaskCartId} />
          <ButtonGroup>
            <Button type="submit" variant="primary">Submit</Button>
          </ButtonGroup>
        </Form>
        <div id={KLARNA_CONTAINER_ID}></div>
        {klarnaReady && (
          <Button variant="cta" onPress={onAuthorize}>Pay with Klarna</Button>
        )}
        {message && <Text>{message}</Text>}
        {authToken && <Text>Authorization token: {authToken}</Text>}
      </View>
    </Provider>
  )
}

export default App
