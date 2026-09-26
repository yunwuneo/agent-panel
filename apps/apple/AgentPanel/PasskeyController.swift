import AuthenticationServices
import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class PasskeyController: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<JSONValue, Error>?
    private var controller: ASAuthorizationController?

    func perform(options: JSONValue, register: Bool) async throws -> JSONValue {
        guard continuation == nil else { throw ClientError.message("已有通行密钥请求正在进行") }
        let rp = options["rpId"].stringValue ?? options["rp"]["id"].stringValue ?? "localhost"
        guard let challengeText = options["challenge"].stringValue, let challenge = Data(base64URL: challengeText) else { throw ClientError.message("通行密钥挑战无效") }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
        let request: ASAuthorizationRequest
        if register {
            guard let id = options["user"]["id"].stringValue, let user = Data(base64URL: id) else { throw ClientError.message("注册用户信息无效") }
            let registration = provider.createCredentialRegistrationRequest(challenge: challenge, name: options["user"]["name"].stringValue ?? "AgentPanel", userID: user)
            registration.userVerificationPreference = .required
            request = registration
        } else {
            let assertion = provider.createCredentialAssertionRequest(challenge: challenge)
            assertion.userVerificationPreference = .required
            request = assertion
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            self.controller = controller
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? NSWindow()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? UIWindow()
        #endif
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        var json: [String: JSONValue]
        if let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            guard let attestation = registration.rawAttestationObject else { finish(.failure(ClientError.message("缺少密钥证明"))); return }
            json = ["id": .string(registration.credentialID.base64URL), "rawId": .string(registration.credentialID.base64URL), "type": .string("public-key"), "authenticatorAttachment": .string("platform"), "clientExtensionResults": .object([:]), "response": .object(["clientDataJSON": .string(registration.rawClientDataJSON.base64URL), "attestationObject": .string(attestation.base64URL), "transports": .array([.string("internal")])])]
        } else if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            json = ["id": .string(assertion.credentialID.base64URL), "rawId": .string(assertion.credentialID.base64URL), "type": .string("public-key"), "authenticatorAttachment": .string("platform"), "clientExtensionResults": .object([:]), "response": .object(["clientDataJSON": .string(assertion.rawClientDataJSON.base64URL), "authenticatorData": .string(assertion.rawAuthenticatorData.base64URL), "signature": .string(assertion.signature.base64URL), "userHandle": .string(assertion.userID.base64URL)])]
        } else { finish(.failure(ClientError.message("不支持的通行密钥响应"))); return }
        finish(.success(.object(json)))
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) { finish(.failure(error)) }
    private func finish(_ result: Result<JSONValue, Error>) {
        let pending = continuation
        continuation = nil
        controller = nil
        pending?.resume(with: result)
    }
}
