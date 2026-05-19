import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const { filename, mimeType, fileSize } = body;

  if (!filename || !mimeType) {
    return json({ error: "Missing filename or mimeType" }, { status: 400 });
  }

  try {
    const res = await admin.graphql(`
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "FILE",
          fileSize: fileSize?.toString()
        }]
      }
    });

    const data = await res.json();
    const errors = data.data?.stagedUploadsCreate?.userErrors;
    
    if (errors && errors.length > 0) {
      return json({ error: errors[0].message }, { status: 400 });
    }

    const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
    return json({ target });
  } catch (err: any) {
    console.error("Staged Upload Error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
